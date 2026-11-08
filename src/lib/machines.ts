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

/** Pull "box6", an InstaBox token / ssh command, or user@host[:port] out of what the user pasted. */
export function parseMachineInput(text: string): { value: string; name?: string } | null {
  const t = text.trim();
  const token = t.match(/ibssh_[A-Za-z0-9]+/)?.[0];
  const name = t.match(/\b(?:name|call it|as)\s*[:=]?\s*([a-z0-9][a-z0-9-]{0,31})\b/i)?.[1]?.toLowerCase();
  if (token) return { value: token, name };
  const ssh = t.match(/(?:ssh\s+(?:-p\s*(\d+)\s+)?)?([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)(?::(\d+))?(?:\s+-p\s*(\d+))?/);
  if (ssh) {
    const port = ssh[1] || ssh[4] || ssh[5];
    return { value: `${ssh[2]}@${ssh[3]}${port ? `:${port}` : ""}`, name };
  }
  return null;
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
  if (all.some((v) => v.host === vm.host && v.username === vm.username && v.port === vm.port)) throw new Error("That machine is already added");

  // 1. it must answer, and gets the agent
  const st = await probe({ ...vm, added: true });
  if (!st.ok) throw new Error(`Couldn't reach it: ${st.error}`);
  const summary = [`${name} is online (${st.agent?.os ?? "Linux"}, ${st.agent?.cores ?? "?"} CPU, ${Math.round((st.agent?.memTotalKb ?? 0) / 1048576)} GB RAM); agent installed`];

  // 2. remember it
  const list = ((await storeGetJson<Entry[]>(PATH)) ?? []).filter((e) => e.name !== name);
  list.push({ name, value: seal(parsed.value, PURPOSE), addedAt: new Date().toISOString() });
  await storePut(PATH, JSON.stringify(list));
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

export async function removeMachine(name: string): Promise<void> {
  if (envVms().some((v) => v.name === name)) throw new Error(`${name} comes from the VMS env var; remove it there`);
  const list = (await storeGetJson<Entry[]>(PATH)) ?? [];
  if (!list.some((e) => e.name === name)) throw new Error(`no added machine called ${name}`);
  await storePut(PATH, JSON.stringify(list.filter((e) => e.name !== name)));
  await refreshMachines(true);
}
