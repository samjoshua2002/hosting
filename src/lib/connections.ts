// Relationships between projects ("watch uses postgres"). Connecting sets the right env var on the app
// (built from the database's stored credentials, which never leave the machines and this server),
// opens a tunnel when they run on different machines, records the link, and restarts the app.
import { ensureAgent, listManifests } from "./agent";
import { getVms, type VmConfig } from "./config";
import { projectType } from "./project-type";
import { mapLimit, run, shq, withVm } from "./ssh";
import { linkTunnel } from "./tunnels";
import type { ProjectManifest } from "./types";

const P = '"$HOME/.hosting/projects"';

interface Where {
  vm: VmConfig;
  m: ProjectManifest;
}

async function locate(name: string): Promise<Where[]> {
  const found = await mapLimit(getVms(), 12, async (vm) => {
    try {
      const ms = await withVm(vm, (c) => listManifests(c));
      const m = ms.find((x) => x.name === name);
      return m ? [{ vm, m }] : [];
    } catch {
      return [];
    }
  });
  return found.flat();
}

export type Engine = "postgres" | "mysql" | "mongo" | "redis";

export function engineOf(m: Pick<ProjectManifest, "start" | "build">): Engine | null {
  const s = `${m.start} ${m.build}`;
  if (/postgres/.test(s)) return "postgres";
  if (/mysql|mariadb/.test(s)) return "mysql";
  if (/mongo/.test(s)) return "mongo";
  if (/redis/.test(s)) return "redis";
  return null;
}

/** The project's env values, read on its machine. Server-side only. */
async function readEnv(vm: VmConfig, name: string): Promise<Record<string, string>> {
  return withVm(vm, async (c) => {
    const r = await run(
      c,
      `f=${P}/${name}.env; [ -f "$f" ] || exit 0; set -a; . "$f"; set +a; for k in $(cut -d= -f1 "$f" | grep -E '^[A-Za-z_][A-Za-z0-9_]*$'); do printf '%s\\0%s\\0' "$k" "\${!k}"; done`,
      { timeoutMs: 15_000 },
    );
    const parts = r.stdout.split("\0");
    const env: Record<string, string> = {};
    for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) env[parts[i]] = parts[i + 1];
    return env;
  });
}

async function readUrl(vm: VmConfig, name: string): Promise<string> {
  return withVm(vm, async (c) => (await run(c, `cat ${P}/${name}.url 2>/dev/null || true`, { timeoutMs: 15_000 })).stdout.trim());
}

const enc = encodeURIComponent;

function defaultEnv(target: ProjectManifest, engine: Engine | null): string {
  if (engine === "mongo") return "MONGODB_URI";
  if (engine === "redis") return "REDIS_URL";
  if (engine) return "DATABASE_URL";
  return `${target.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL`;
}

/** Change one env key (value null removes it) and the manifest's links, on one machine. */
async function editApp(vm: VmConfig, app: string, key: string, value: string | null, uses: ProjectManifest["uses"]): Promise<void> {
  await withVm(vm, async (c) => {
    await ensureAgent(c);
    const line = value === null ? "" : `${key}=${shq(value)}\n`;
    const r1 = await run(c, `umask 077; f=${P}/${app}.env; touch "$f"; { grep -v '^${key}=' "$f"; cat; } > "$f.tmp" && mv -f "$f.tmp" "$f"`, { stdin: line, timeoutMs: 15_000 });
    if (r1.code !== 0) throw new Error(`could not update ${app}'s env on ${vm.name}`);
    const cur = await run(c, `cat ${P}/${app}.json`, { timeoutMs: 15_000 });
    const m = JSON.parse(cur.stdout) as ProjectManifest;
    const keys = new Set(m.envKeys);
    if (value === null) keys.delete(key);
    else keys.add(key);
    const next: ProjectManifest = { ...m, uses: uses?.length ? uses : undefined, envKeys: [...keys], updatedAt: new Date().toISOString() };
    const b64 = Buffer.from(JSON.stringify(next)).toString("base64");
    const r2 = await run(c, `umask 077; echo ${b64} | base64 -d > ${P}/${app}.json.tmp && mv -f ${P}/${app}.json.tmp ${P}/${app}.json`, { timeoutMs: 15_000 });
    if (r2.code !== 0) throw new Error(`could not save ${app} on ${vm.name}`);
    // the start script reads the env file, so a restart picks the change up
    if (m.start) await run(c, `systemctl --user restart hosting-${app}.service`, { timeoutMs: 30_000 });
  });
}

export async function connectProjects(from: string, to: string, envName?: string): Promise<string> {
  if (from === to) throw new Error("pick two different projects");
  const [apps, targets] = await Promise.all([locate(from), locate(to)]);
  if (!apps.length) throw new Error(`no project called ${from} on a reachable machine`);
  if (!targets.length) throw new Error(`no project called ${to} on a reachable machine`);
  const target = targets[0];
  const engine = projectType(target.m) === "database" ? engineOf(target.m) : null;
  const key = envName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) ? envName : defaultEnv(target.m, engine);
  const notes: string[] = [];

  // what the app should connect to, per app machine
  let value: (vm: VmConfig) => Promise<string>;
  if (engine) {
    if (!target.m.port) throw new Error(`${to} has no port`);
    const env = await readEnv(target.vm, to);
    const port = target.m.port;
    const url = {
      postgres: () => `postgresql://${enc(env.POSTGRES_USER || "postgres")}:${enc(env.POSTGRES_PASSWORD ?? "")}@127.0.0.1:${port}/${enc(env.POSTGRES_DB || env.POSTGRES_USER || "postgres")}`,
      mysql: () => `mysql://root:${enc(env.MYSQL_ROOT_PASSWORD ?? "")}@127.0.0.1:${port}/${enc(env.MYSQL_DATABASE || "mysql")}`,
      mongo: () => `mongodb://${enc(env.MONGO_INITDB_ROOT_USERNAME || "admin")}:${enc(env.MONGO_INITDB_ROOT_PASSWORD ?? "")}@127.0.0.1:${port}/?authSource=admin`,
      redis: () => (env.REDIS_PASSWORD ? `redis://:${enc(env.REDIS_PASSWORD)}@127.0.0.1:${port}` : `redis://127.0.0.1:${port}`),
    }[engine]();
    value = async () => url;
    // other machines reach the database through a tunnel on the same port
    for (const a of apps) {
      if (a.vm.name === target.vm.name) continue;
      const t = await linkTunnel(a.vm, target.vm, [port]);
      if (t.skipped.includes(port)) throw new Error(`port ${port} is already used by something else on ${a.vm.name}, so the tunnel can't open there`);
      notes.push(`tunnel ${a.vm.name} → ${target.vm.name} on :${port}`);
    }
  } else {
    const link = await readUrl(target.vm, to);
    value = async (vm) => {
      if (vm.name === target.vm.name && target.m.port) return `http://127.0.0.1:${target.m.port}`;
      if (link) return link;
      throw new Error(`${to} has no link that ${vm.name} can reach; give it a public or private link first`);
    };
  }

  const uses = [...(apps[0].m.uses ?? []).filter((u) => u.name !== to), { name: to, env: key }];
  await mapLimit(apps, 8, async (a) => editApp(a.vm, from, key, await value(a.vm), uses));
  return `Connected ${from} → ${to}: ${key} is set on ${apps.map((a) => a.vm.name).join(", ")} and ${from} restarted.${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

export async function disconnectProjects(from: string, to: string): Promise<string> {
  const apps = await locate(from);
  if (!apps.length) throw new Error(`no project called ${from} on a reachable machine`);
  const link = apps[0].m.uses?.find((u) => u.name === to);
  if (!link) throw new Error(`${from} isn't connected to ${to}`);
  const uses = (apps[0].m.uses ?? []).filter((u) => u.name !== to);
  await mapLimit(apps, 8, async (a) => editApp(a.vm, from, link.env, null, uses));
  return `Disconnected ${from} from ${to}: removed ${link.env} and restarted ${from}.`;
}
