// Autopilot: every 15 minutes (a cron task on the storage machine calls /api/cron/autopilot) it checks the
// fleet, fixes the safe things itself (crashed services, dropped tunnels, full disks), and hands anything
// left to the Assistant in a daily "Autopilot" session. Destructive steps still wait for the user.
import { cronAction, probe, projectAction } from "./agent";
import { aiConfigured } from "./ai";
import { getVms } from "./config";
import { sendAlert } from "./mail";
import { BusyError, prepareRun, runSession } from "./session-run";
import { mapLimit, run, withVm } from "./ssh";
import { storeGetJson, storePut, storeVm } from "./store";
import type { VmStatus } from "./types";

const PATH = "assistant/autopilot.json";

export interface AutopilotState {
  enabled: boolean;
  lastRun?: number;
  lastSummary?: string;
  lastActions?: string[];
  sessionId?: string;
}

export async function getAutopilot(): Promise<AutopilotState> {
  return (await storeGetJson<AutopilotState>(PATH)) ?? { enabled: false };
}

async function save(s: AutopilotState) {
  await storePut(PATH, JSON.stringify(s));
}

/** Turn it on or off: the schedule lives on the storage machine, with the secret in a private file. */
export async function setAutopilot(enabled: boolean, appUrl: string): Promise<AutopilotState> {
  const secret = process.env.CRON_SECRET;
  if (enabled && !secret) throw new Error("Set CRON_SECRET in the environment first (it signs Autopilot's calls)");
  const vm = storeVm();
  if (enabled) {
    await withVm(vm, async (c) => {
      const r = await run(c, 'mkdir -p "$HOME/.hosting" && umask 077 && cat > "$HOME/.hosting/autopilot.secret"', { stdin: secret, timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error("couldn't store the Autopilot secret");
    });
    const url = `${appUrl.replace(/\/$/, "")}/api/cron/autopilot`;
    await cronAction(vm, "add", "autopilot", "*/15 * * * *", `curl -fsS -m 290 -H "Authorization: Bearer $(cat "$HOME/.hosting/autopilot.secret")" "${url}" >/dev/null`);
  } else {
    await cronAction(vm, "remove", "autopilot").catch(() => "");
  }
  const s = { ...(await getAutopilot()), enabled };
  await save(s);
  return s;
}

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** One check-and-fix pass. */
export async function runAutopilot(opts: { force?: boolean } = {}): Promise<AutopilotState> {
  const state = await getAutopilot();
  if (!state.enabled && !opts.force) return state;
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
    for (const t of a.tunnels.filter((x) => x.active !== "active")) {
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

  // did the restarts hold?
  if (actions.some((x) => x.startsWith("restarted ") && !x.includes("tunnel"))) {
    await new Promise((r) => setTimeout(r, 8000));
    fleet = await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999));
    for (const s of fleet) for (const p of s.agent?.projects.filter((x) => x.active === "failed") ?? []) problems.push(`${p.manifest.name} on ${s.name} keeps crashing after a restart`);
  }

  // anything left goes to the Assistant
  let sessionId: string | undefined;
  const real = problems.filter((p) => !/unreachable/.test(p));
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
  const next: AutopilotState = { ...state, lastRun: Date.now(), lastSummary: summary, lastActions: actions, sessionId: sessionId ?? state.sessionId };
  await save(next);
  return next;
}
