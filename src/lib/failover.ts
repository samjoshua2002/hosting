// Failover: the storage machine keeps a sealed copy of every project's settings (manifest + env), refreshed on
// every Autopilot pass. When a machine stays unreachable, its stateless apps are started on a healthy machine
// from that copy (code from GitHub or the Docker image), with database tunnels rebuilt, so /go links keep working.
// Databases and anything keeping data on the lost machine's disk stay put: their data is there.
import { PROJECT_NAME_RE, saveProject, startDeploy } from "./agent";
import { getVm, type VmConfig } from "./config";
import { rankMachines } from "./placement";
import { seal, unseal, type Sealed } from "./seal";
import { run, withVm } from "./ssh";
import { storeGetJson, storePut } from "./store";
import { linkTunnel } from "./tunnels";
import type { ProjectManifest, VmStatus } from "./types";

const SNAP = "fleet/snapshot.json";
const DOWN = "fleet/down.json";
const MOVES = "fleet/failovers.json";
const PURPOSE = "fleet-snapshot:v1";
/** how long a machine must stay unreachable before its apps move (InstaBox pauses and short cool-downs are normal) */
export const DOWN_MINUTES = 10;

export interface SnapItem {
  vm: string;
  manifest: ProjectManifest;
  env: Record<string, string>;
  at: number;
}
type Snapshot = Record<string, SnapItem>; // key: <project>@<vm>
export interface Move {
  project: string;
  from: string;
  to: string;
  at: number;
  jobId: string;
}

async function readSnapshot(): Promise<Snapshot> {
  const s = await storeGetJson<Sealed>(SNAP);
  return s ? (JSON.parse(unseal(s, PURPOSE)) as Snapshot) : {};
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    // the dashboard writes values single-quoted (shq): 'it'\''s' → it's
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
    out[m[1]] = v;
  }
  return out;
}

/** Refresh the copy for every reachable machine; unreachable machines keep their last copy. */
export async function snapshotFleet(fleet: VmStatus[]): Promise<number> {
  const prev = await readSnapshot().catch(() => ({}) as Snapshot);
  const next: Snapshot = {};
  for (const [k, v] of Object.entries(prev)) if (!fleet.find((s) => s.name === v.vm)?.ok) next[k] = v; // keep the lost ones
  await Promise.all(
    fleet
      .filter((s) => s.ok && s.agent)
      .map(async (s) => {
        const vm = getVm(s.name);
        if (!vm) return;
        const r = await withVm(vm, (c) =>
          run(c, 'for f in "$HOME"/.hosting/projects/*.env; do [ -e "$f" ] || continue; printf "\\036%s\\n" "$(basename "$f" .env)"; cat "$f"; echo; done', { timeoutMs: 20_000 }),
        ).catch(() => null);
        const envs: Record<string, Record<string, string>> = {};
        for (const chunk of (r?.stdout ?? "").split("\x1e").slice(1)) {
          const nl = chunk.indexOf("\n");
          envs[chunk.slice(0, nl).trim()] = parseEnv(chunk.slice(nl + 1));
        }
        for (const p of s.agent!.projects) next[`${p.manifest.name}@${s.name}`] = { vm: s.name, manifest: p.manifest, env: envs[p.manifest.name] ?? {}, at: Date.now() };
      }),
  );
  await storePut(SNAP, JSON.stringify(seal(JSON.stringify(next), PURPOSE)));
  return Object.keys(next).length;
}

/** Can this project run somewhere else from its saved settings alone? */
export function movable(m: ProjectManifest): { ok: true } | { ok: false; why: string } {
  if (m.category === "database") return { ok: false, why: "it's a database: its data is on that machine's disk" };
  if (/(\$HOME|~|\/home\/[^/]+)\/data\b/.test(`${m.install}\n${m.start}`)) return { ok: false, why: "it keeps data on that machine's disk" };
  if (!m.start) return { ok: false, why: "it has no start command" };
  if (!m.repo && !/docker run/.test(m.start)) return { ok: false, why: "its code isn't in a repository, only on that machine" };
  return { ok: true };
}

/** Start a copy of <name> (from the saved settings) on the best healthy machine, or the one given. */
export async function moveProject(name: string, opts: { fleet: VmStatus[]; to?: string; from?: string }): Promise<Move> {
  if (!PROJECT_NAME_RE.test(name)) throw new Error("not a project name");
  const snap = await readSnapshot();
  const copies = Object.values(snap).filter((x) => x.manifest.name === name && (!opts.from || x.vm === opts.from));
  if (!copies.length) throw new Error(`no saved settings for ${name} (Autopilot saves them every 15 minutes while its machine is up)`);
  const item = copies.sort((a, b) => b.at - a.at)[0];
  const m = item.manifest;
  const can = movable(m);
  if (!can.ok) throw new Error(`${name} can't move: ${can.why}`);

  const ok = opts.fleet.filter((s) => s.ok && s.agent);
  const hosting = new Set(ok.filter((s) => s.agent!.projects.some((p) => p.manifest.name === name)).map((s) => s.name));
  const freeGb = (s: VmStatus) => (s.agent ? (s.agent.diskTotalKb - s.agent.diskUsedKb) / 1048576 : 0);
  const st = Object.fromEntries(ok.map((s) => [s.name, s]));
  const kind = m.category === "tool" ? "tool" : (m.kind ?? "app");
  const toName =
    opts.to ??
    rankMachines(
      ok.filter((s) => !hosting.has(s.name) && s.name !== item.vm && freeGb(s) >= 1.5).map((s) => s.name),
      st,
      kind,
      process.env.STORE_VM || "box5",
    )[0];
  const to: VmConfig | undefined = toName ? getVm(toName) : undefined;
  if (!to || !st[to.name]) throw new Error(opts.to ? `${opts.to} isn't reachable` : "no healthy machine with room to take it");

  // its port may be taken there
  const taken = new Set(st[to.name].agent!.projects.map((p) => p.manifest.port).filter(Boolean));
  let port = m.port;
  if (port !== null) while (taken.has(port)) port++;

  const jobId = await withVm(to, async (c) => {
    await saveProject(c, {
      name,
      repo: m.repo,
      branch: m.branch,
      install: m.install,
      build: m.build,
      start: m.start,
      port,
      publish: m.publish,
      access: m.access ?? "public",
      category: m.category ?? "app",
      kind: m.kind,
      framework: m.framework,
      github: m.github ?? null,
      uses: m.uses,
      template: m.template,
      service: m.service,
      env: { ...item.env, ...(port !== null ? { PORT: String(port) } : {}) },
    });
    return startDeploy(c, name, "failover");
  });

  // databases it talks to: tunnel from the new machine (same ports as before, so its settings still work)
  for (const u of m.uses ?? []) {
    const db = Object.values(snap).find((x) => x.manifest.name === u.name && x.manifest.category === "database");
    const dbVm = db ? getVm(db.vm) : undefined;
    if (db && dbVm && dbVm.name !== to.name && db.manifest.port) await linkTunnel(to, dbVm, [db.manifest.port]).catch(() => null);
  }

  const move: Move = { project: name, from: item.vm, to: to.name, at: Date.now(), jobId };
  const log = ((await storeGetJson<Move[]>(MOVES).catch(() => null)) ?? []).concat(move).slice(-100);
  await storePut(MOVES, JSON.stringify(log)).catch(() => null);
  return move;
}

/**
 * One pass: note which machines are down, and for any down at least DOWN_MINUTES, move each of its apps that
 * isn't running anywhere else. Returns what it did and what it couldn't do, in plain sentences.
 */
export async function failover(fleet: VmStatus[]): Promise<{ actions: string[]; problems: string[] }> {
  const actions: string[] = [];
  const problems: string[] = [];
  const now = Date.now();
  const down = (await storeGetJson<Record<string, number>>(DOWN).catch(() => null)) ?? {};
  for (const s of fleet) {
    if (s.ok) delete down[s.name];
    else down[s.name] ??= now;
  }
  await storePut(DOWN, JSON.stringify(down)).catch(() => null);

  const lost = Object.entries(down).filter(([, since]) => now - since >= DOWN_MINUTES * 60_000).map(([n]) => n);
  if (!lost.length) return { actions, problems };
  const snap = await readSnapshot().catch(() => ({}) as Snapshot);
  const moves = await recentMoves();
  const runningElsewhere = (name: string) => fleet.some((s) => s.ok && s.agent?.projects.some((p) => p.manifest.name === name && p.active === "active"));

  for (const vmName of lost) {
    const mins = Math.round((now - down[vmName]) / 60_000);
    for (const item of Object.values(snap).filter((x) => x.vm === vmName)) {
      const name = item.manifest.name;
      if (runningElsewhere(name)) continue;
      // one attempt per hour per app: a copy that's still starting (or failed) shouldn't spread over every machine
      const tried = moves.find((m) => m.project === name && m.from === vmName && now - m.at < 60 * 60_000);
      if (tried) {
        problems.push(`${name} was moved from ${vmName} to ${tried.to} ${Math.round((now - tried.at) / 60_000)} min ago but isn't running there yet (check its deploy job ${tried.jobId})`);
        continue;
      }
      const can = movable(item.manifest);
      if (!can.ok) {
        problems.push(`${name} is down with ${vmName} (unreachable for ${mins} min) and stays there: ${can.why}`);
        continue;
      }
      try {
        const mv = await moveProject(name, { fleet, from: vmName });
        actions.push(`${vmName} has been unreachable for ${mins} min: started ${name} on ${mv.to} instead (deploy job ${mv.jobId}); its /go link follows it`);
      } catch (e) {
        problems.push(`${name} is down with ${vmName} and couldn't move: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
  return { actions, problems };
}

/** Recent failovers, for the Assistant and the UI. */
export async function recentMoves(): Promise<Move[]> {
  return (await storeGetJson<Move[]>(MOVES).catch(() => null)) ?? [];
}
