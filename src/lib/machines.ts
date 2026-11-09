// Machines added from the dashboard or the Assistant (on top of the VMS env var). Kept on the storage
// machine; InstaBox tokens are encrypted. Adding one installs the agent and sets it up like the others.
import { cronAction, probe } from "./agent";
import { envVms, getVms, parseVms, setExtraVms, type VmConfig } from "./config";
import { seal, unseal, type Sealed } from "./seal";
import { mapLimit } from "./ssh";
import { storeGetJson, storePut } from "./store";
import { linkTunnel } from "./tunnels";

const PATH = "machines/registry.json";
const PURPOSE = "machine:v1";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface Entry {
  name: string;
  value: Sealed;
  addedAt: string;
}

let loadedAt = 0;

// registry changes run one at a time in this server, re-reading the file inside the lock
let registryLock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = registryLock.then(fn, fn);
  registryLock = next.catch(() => undefined);
  return next;
}
let loading: Promise<void> | null = null;

async function load(): Promise<void> {
  const list = (await storeGetJson<Entry[]>(PATH)) ?? [];
  const vms: VmConfig[] = [];
  for (const e of list) {
    try {
      const v = parseVms(`${e.name}=${unseal(e.value, PURPOSE)}`).vms[0];
      if (v) vms.push({ ...v, added: true });
    } catch {
      /* SESSION_SECRET changed: that entry needs adding again */
    }
  }
  setExtraVms(vms);
  loadedAt = Date.now();
}

/**
 * Keep the added machines fresh. The first call in a server instance waits (at most a few seconds);
 * after that the list refreshes in the background about once a minute, so requests never wait on it.
 */
export async function refreshMachines(force = false): Promise<void> {
  if (!force && loadedAt && Date.now() - loadedAt < 60_000) return;
  if (!loading)
    loading = load()
      .catch((e) => console.error("machine registry", e))
      .finally(() => {
        loading = null;
      });
  if (force || !loadedAt) await Promise.race([loading, new Promise((r) => setTimeout(r, 8000))]);
}

const NOT_NAMES = new Set(["no", "yes", "the", "a", "an", "it", "this", "that", "user", "password", "ssh", "key", "token", "host", "port", "name", "machine", "server", "box"]);

/**
 * Pull the token / ssh command / user@host out of whatever the user pasted, plus a name only when they
 * clearly gave one ("box6", "call it web-1"). Pasted InstaBox pages say things like "user name: no
 * password", so loose phrases are never taken as names.
 */
export function parseMachineInput(text: string): { value: string; name?: string } | null {
  const t = text.trim();
  const said = t.match(/\b(box\d{1,3})\b/i)?.[1] ?? t.match(/\b(?:call it|name it|named|rename (?:it )?to)\s+["'`]?([a-z][a-z0-9-]{1,31})/i)?.[1];
  const name = said && !NOT_NAMES.has(said.toLowerCase()) ? said.toLowerCase() : undefined;
  const token = t.match(/ibssh_[A-Za-z0-9]+/)?.[0];
  if (token) return { value: token, name };
  const ssh = t.match(/(?:ssh\s+(?:-p\s*(\d+)\s+)?)?([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)(?::(\d+))?(?:\s+-p\s*(\d+))?/);
  if (ssh) {
    const port = ssh[1] || ssh[4] || ssh[5];
    return { value: `${ssh[2]}@${ssh[3]}${port ? `:${port}` : ""}`, name };
  }
  return null;
}

/** Hide machine tokens in any text that's about to be shown, saved or sent to a model. */
export function maskTokens(text: string): string {
  return text.replace(/ibssh_[A-Za-z0-9]{4,}/g, "ibssh_••••(hidden)");
}

function nextName(): string {
  const taken = new Set(getVms().map((v) => v.name));
  for (let i = 1; ; i++) if (!taken.has(`box${i}`)) return `box${i}`;
}

export async function addMachine(text: string, wanted?: string): Promise<{ name: string; summary: string[] }> {
  await refreshMachines(true);
  const parsed = parseMachineInput(text);
  if (!parsed) throw new Error("Paste the machine's SSH command or token (ibssh_…), or user@host:port");
  const name = (wanted || parsed.name || nextName()).toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("name: lowercase letters, digits and dashes");
  const all = getVms();
  if (all.some((v) => v.name === name)) throw new Error(`${name} already exists`);
  const vm = parseVms(`${name}=${parsed.value}`).vms[0];
  if (!vm) throw new Error("That doesn't look like an InstaBox token or user@host");
  const same = all.find((v) => v.host === vm.host && v.username === vm.username && v.port === vm.port);
  if (same) throw new Error(`That machine is already added as ${same.name}`);

  // 1. it must answer, and gets the agent
  const st = await probe({ ...vm, added: true });
  if (!st.ok) throw new Error(`Couldn't reach it: ${st.error}`);
  const summary = [`${name} is online (${st.agent?.os ?? "Linux"}, ${st.agent?.cores ?? "?"} CPU, ${Math.round((st.agent?.memTotalKb ?? 0) / 1048576)} GB RAM); agent installed`];

  // 2. remember it (read right before writing, inside the lock)
  await locked(async () => {
    const list = ((await storeGetJson<Entry[]>(PATH)) ?? []).filter((e) => e.name !== name);
    list.push({ name, value: seal(parsed.value, PURPOSE), addedAt: new Date().toISOString() });
    await storePut(PATH, JSON.stringify(list));
  });
  await refreshMachines(true);

  // 3. set it up like the others: database tunnels, and the keep-alive tasks every machine runs
  const others = getVms().filter((v) => v.name !== name);
  const facts = await mapLimit(others, 12, async (o) => {
    const s = await probe(o);
    const dbPorts = s.ok && s.agent ? s.agent.projects.filter((p) => p.manifest.category === "database" && p.manifest.port).map((p) => p.manifest.port!) : [];
    return { vm: o, ok: s.ok, dbPorts, cron: s.agent?.cron ?? [] };
  });
  for (const f of facts.filter((x) => x.dbPorts.length)) {
    if (vm.kind !== "instabox" || f.vm.kind !== "instabox") continue;
    try {
      const t = await linkTunnel(vm, f.vm, f.dbPorts);
      summary.push(`databases on ${f.vm.name} reachable at 127.0.0.1:${t.forwarded.join(", :")}`);
    } catch (e) {
      summary.push(`couldn't open the tunnel to ${f.vm.name}: ${(e as Error).message}`);
    }
  }
  const online = facts.filter((x) => x.ok);
  if (online.length) {
    const shared = online[0].cron.filter((c) => online.every((o) => o.cron.some((x) => x.schedule === c.schedule && x.command === c.command)));
    let n = 0;
    for (const c of shared) {
      try {
        await cronAction({ ...vm, added: true }, "add", c.name || `keepalive${n ? `-${n}` : ""}`, c.schedule, c.command);
        n++;
      } catch (e) {
        summary.push(`couldn't copy a scheduled task: ${(e as Error).message}`);
      }
    }
    if (n) summary.push(`copied ${n} scheduled task${n > 1 ? "s" : ""} every machine runs (keep-alive)`);
  }
  return { name, summary };
}

/** Rename a machine added from the dashboard (the registry entry; nothing on the machine refers to its name). */
export async function renameMachine(from: string, to: string): Promise<void> {
  const next = to.trim().toLowerCase();
  if (!NAME_RE.test(next)) throw new Error("name: lowercase letters, digits and dashes");
  if (envVms().some((v) => v.name === from)) throw new Error(`${from} comes from the VMS env var; rename it there`);
  if (getVms().some((v) => v.name === next)) throw new Error(`${next} is already taken`);
  await locked(async () => {
    const list = (await storeGetJson<Entry[]>(PATH)) ?? [];
    const e = list.find((x) => x.name === from);
    if (!e) throw new Error(`no added machine called ${from}`);
    e.name = next;
    await storePut(PATH, JSON.stringify(list));
  });
  await refreshMachines(true);
}

export async function removeMachine(name: string): Promise<void> {
  if (envVms().some((v) => v.name === name)) throw new Error(`${name} comes from the VMS env var; remove it there`);
  await locked(async () => {
    const list = (await storeGetJson<Entry[]>(PATH)) ?? [];
    if (!list.some((e) => e.name === name)) throw new Error(`no added machine called ${name}`);
    await storePut(PATH, JSON.stringify(list.filter((e) => e.name !== name)));
  });
  await refreshMachines(true);
}
