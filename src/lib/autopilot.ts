// Autopilot: every 15 minutes (a cron task on the storage machine calls /api/cron/autopilot) it checks the
// fleet, fixes the safe things itself (crashed services, dropped tunnels, full disks), and hands anything
// left to the Assistant in a daily "Autopilot" session. Destructive steps still wait for the user.
import { cronAction, probe, projectAction } from "./agent";
import { aiConfigured } from "./ai";
import { getVms } from "./config";
import { failover, snapshotFleet } from "./failover";
import { sendAlert } from "./mail";
import { BusyError, prepareRun, runSession } from "./session-run";
import { mapLimit, run, withVm } from "./ssh";
import { storeBackend, storeGetJson, storePut } from "./store";
import { mirrorStore } from "./store-location";
import type { VmConfig } from "./config";
import type { VmStatus } from "./types";

const PATH = "assistant/autopilot.json";

export interface AutopilotState {
  enabled: boolean;
  lastRun?: number;
  lastSummary?: string;
  lastActions?: string[];
  sessionId?: string;
  /** the dashboard's address the machines ping */
  appUrl?: string;
}

export async function getAutopilot(): Promise<AutopilotState> {
  return (await storeGetJson<AutopilotState>(PATH)) ?? { enabled: false };
}

async function save(s: AutopilotState) {
  await storePut(PATH, JSON.stringify(s));
}

const CRON_NAME = "autopilot";
/** Each machine pings at its own minute; runs closer than this are skipped, so it's one pass per 15 minutes. */
const MIN_GAP_MS = 10 * 60_000;

function pingCommand(appUrl: string): string {
  const url = `${appUrl.replace(/\/$/, "")}/api/cron/autopilot`;
  return `curl -fsS -m 290 -H "Authorization: Bearer $(cat "$HOME/.hosting/autopilot.secret")" "${url}" >/dev/null`;
}

/** Install (or refresh) the Autopilot ping on one machine; minute offset spreads machines over the 15 minutes. */
async function installPing(vm: VmConfig, appUrl: string, offset: number): Promise<void> {
  const secret = process.env.CRON_SECRET!;
  await withVm(vm, async (c) => {
    const r = await run(c, 'mkdir -p "$HOME/.hosting" && umask 077 && cat > "$HOME/.hosting/autopilot.secret"', { stdin: secret, timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error("couldn't store the Autopilot secret");
  });
  const m = offset % 15;
  await cronAction(vm, "add", CRON_NAME, `${m},${m + 15},${m + 30},${m + 45} * * * *`, pingCommand(appUrl));
}

/**
 * Turn it on or off. Every reachable machine gets a small ping that calls the dashboard every 15 minutes
 * (staggered), so Autopilot keeps running as long as any one machine is up; no machine is special.
 * Servers that stay running (Render, a VPS) also run it on an internal timer (see instrumentation.ts).
 */
export async function setAutopilot(enabled: boolean, appUrl: string): Promise<AutopilotState> {
  if (enabled && !process.env.CRON_SECRET) throw new Error("Set CRON_SECRET in the environment first (it signs Autopilot's calls)");
  const vms = getVms();
  const results = await mapLimit(vms, 6, async (vm) => {
    try {
      if (enabled) await installPing(vm, appUrl, vms.indexOf(vm) * 4 + 1);
      else await cronAction(vm, "remove", CRON_NAME);
      return true;
    } catch {
      return false; // resting machines get it on a later pass
    }
  });
  if (enabled && !results.some(Boolean) && !process.env.INTERNAL_SCHEDULER) throw new Error("no machine is reachable to run Autopilot's schedule; try again in a minute");
  const s = { ...(await getAutopilot()), enabled, appUrl: appUrl.replace(/\/$/, "") };
  await save(s);
  return s;
}

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** One check-and-fix pass. */
let running = false;

export async function runAutopilot(opts: { force?: boolean } = {}): Promise<AutopilotState> {
  const state = await getAutopilot();
  if (!state.enabled && !opts.force) return state;
  // several machines ping it (and maybe an internal timer): one pass per window is enough
  if (!opts.force && (running || (state.lastRun && Date.now() - state.lastRun < MIN_GAP_MS))) return state;
  running = true;
  try {
    return await pass(state);
  } finally {
    running = false;
  }
}

async function pass(state: AutopilotState): Promise<AutopilotState> {
  const since = state.lastRun ?? Date.now() - 60 * 60_000;
  const actions: string[] = [];
  const problems: string[] = [];

  let fleet: VmStatus[] = await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999));
  for (const s of fleet) {
    const vm = getVms().find((v) => v.name === s.name)!;
    const a = s.agent;
    if (!s.ok || !a) {
      problems.push(`${s.name} is unreachable (${s.error ?? "no answer"})`);
      continue;
    }
    // the ping that keeps Autopilot running: machines added later (or reset) get it here
    if (state.appUrl && process.env.CRON_SECRET && !a.cron.some((t) => t.name === CRON_NAME)) {
      await installPing(vm, state.appUrl, getVms().findIndex((v) => v.name === s.name) * 4 + 1).catch(() => null);
      actions.push(`set up the Autopilot schedule on ${s.name}`);
    }
    // crashed services: one restart each
    for (const p of a.projects.filter((x) => x.active === "failed")) {
      try {
        await projectAction(vm, p.manifest.name, "restart");
        actions.push(`restarted ${p.manifest.name} on ${s.name} (it had crashed)`);
      } catch (e) {
        problems.push(`${p.manifest.name} on ${s.name} crashed and won't restart: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    // dropped database tunnels
    for (const t of a.tunnels.filter((x) => x.active !== "active" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(x.to))) {
      await withVm(vm, (c) => run(c, `systemctl --user restart hosting-tunnel-${t.to}.service`, { timeoutMs: 20_000 })).catch(() => null);
      actions.push(`restarted the database tunnel ${s.name} → ${t.to}`);
    }
    // nearly full disks: clear what Docker no longer uses (images nothing runs, build cache)
    if (a.diskTotalKb && a.diskUsedKb / a.diskTotalKb > 0.9) {
      const r = await withVm(vm, (c) => run(c, "docker image prune -f 2>/dev/null | tail -1; docker builder prune -f 2>/dev/null | tail -1", { timeoutMs: 120_000 })).catch(() => null);
      actions.push(`${s.name} disk was ${Math.round((a.diskUsedKb / a.diskTotalKb) * 100)}% full: cleared unused Docker data${r?.stdout.trim() ? ` (${r.stdout.trim().split("\n").join(", ")})` : ""}`);
    }
    // deploys that failed since the last pass
    const latest = new Map<string, (typeof a.jobs)[number]>();
    for (const j of [...a.jobs].sort((x, y) => x.meta.startedAt - y.meta.startedAt)) if (j.meta.kind === "deploy" && j.meta.project) latest.set(j.meta.project, j);
    for (const [name, j] of latest)
      if (j.state === "done" && j.exitCode !== 0 && j.meta.startedAt * 1000 > since) problems.push(`the last deploy of ${name} on ${s.name} failed (job ${j.id})`);
  }

  // the dashboard's own data: a fresh copy on a second machine, so a resting storage machine never strands it
  if (storeBackend() === "machine") {
    try {
      const copy = await mirrorStore(fleet.filter((x) => x.ok).map((x) => x.name));
      if (copy && !state.lastActions?.some((x) => x.includes(`copy of the dashboard's data on ${copy.vm}`))) actions.push(`kept a copy of the dashboard's data on ${copy.vm}`);
    } catch (e) {
      problems.push(`couldn't copy the dashboard's data to a second machine: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  // keep a copy of every app's settings, and move apps off machines that stay down
  await snapshotFleet(fleet).catch((e) => problems.push(`couldn't save the fleet's settings copy: ${(e as Error).message.slice(0, 120)}`));
  const fo = await failover(fleet).catch((e) => ({ actions: [] as string[], problems: [`failover check failed: ${(e as Error).message.slice(0, 120)}`] }));
  actions.push(...fo.actions);
  problems.push(...fo.problems);

  // did the restarts hold?
  if (actions.some((x) => x.startsWith("restarted ") && !x.includes("tunnel"))) {
    await new Promise((r) => setTimeout(r, 8000));
    fleet = await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999));
    for (const s of fleet) for (const p of s.agent?.projects.filter((x) => x.active === "failed") ?? []) problems.push(`${p.manifest.name} on ${s.name} keeps crashing after a restart`);
  }

  // anything left goes to the Assistant
  let sessionId: string | undefined;
  const real = problems.filter((p) => !/unreachable|stays there:/.test(p));
  if (real.length && aiConfigured()) {
    sessionId = `autopilot-${today()}`;
    const message = [
      "Autopilot found these problems on the fleet:",
      ...real.map((p) => `- ${p}`),
      actions.length ? `It already did: ${actions.join("; ")}.` : "",
      "Investigate each one (logs, job_log, fleet_status) and fix it with safe steps: correct the configuration or commands, restart, redeploy. Don't delete anything; destructive steps wait for the user's approval. Save a Lesson if you learn something. End with a short summary of what you fixed and what still needs the user.",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const req = { sessionId, message, review: "auto" as const, title: `Autopilot · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`, source: "autopilot" as const };
      const prepared = await prepareRun(req);
      await runSession(req, prepared.doc, prepared.history);
      actions.push("asked the Assistant to fix the rest (see the Autopilot session)");
    } catch (e) {
      if (!(e instanceof BusyError)) actions.push(`couldn't start the Assistant: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  const summary = !actions.length && !problems.length ? "All healthy." : [...actions, ...problems.map((p) => `needs attention: ${p}`)].join("\n");
  if (actions.length || real.length)
    await sendAlert(
      `Autopilot: ${actions.length} fix${actions.length === 1 ? "" : "es"}${real.length ? `, ${real.length} problem${real.length === 1 ? "" : "s"}` : ""}`,
      "Autopilot checked your machines.",
      [...actions.map((t) => ({ tone: "good" as const, title: "Fixed", detail: t })), ...real.map((t) => ({ tone: "warning" as const, title: "Needs attention", detail: t }))],
    ).catch(() => false);
  // re-read: the user may have switched it off during this pass
  const now = await getAutopilot().catch(() => state);
  const next: AutopilotState = { ...now, lastRun: Date.now(), lastSummary: summary, lastActions: actions, sessionId: sessionId ?? now.sessionId };
  await save(next);
  return next;
}
