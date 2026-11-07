// Server-side operations on a VM, all going through the hostctl agent.
import type { Client } from "ssh2";
import { AGENT_SCRIPT, AGENT_VERSION } from "./agent-script.generated";
import type { VmConfig } from "./config";
import { run, shq, withVm } from "./ssh";
import type { AgentStatus, JobLog, JobMeta, ProjectManifest, PublishedPort, VmStatus } from "./types";

const HOSTCTL = '"$HOME/.hosting/bin/hostctl"';

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JOB_ID_RE = /^[a-z0-9-]{6,64}$/;

export function newJobId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

async function installAgent(conn: Client): Promise<void> {
  const res = await run(
    conn,
    'mkdir -p "$HOME/.hosting/bin" && cat > "$HOME/.hosting/bin/hostctl.new" && chmod +x "$HOME/.hosting/bin/hostctl.new" && mv -f "$HOME/.hosting/bin/hostctl.new" "$HOME/.hosting/bin/hostctl"',
    { stdin: AGENT_SCRIPT, timeoutMs: 20_000 },
  );
  if (res.code !== 0) throw new Error(`Agent install failed: ${res.stderr.trim() || `exit ${res.code}`}`);
}

/** Make sure the VM runs the current agent version. */
export async function ensureAgent(conn: Client): Promise<void> {
  const res = await run(conn, `${HOSTCTL} version 2>/dev/null || true`, { timeoutMs: 15_000 });
  if (res.stdout.trim() !== AGENT_VERSION) await installAgent(conn);
}

interface RawStatus extends Omit<AgentStatus, "ports"> {
  ports: { ports?: PublishedPort[] } | null;
}

function parseStatus(text: string): AgentStatus | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const raw = JSON.parse(text.slice(start)) as RawStatus;
    return {
      ...raw,
      ports: (raw.ports?.ports ?? []).map((p) => ({ port: p.port, name: p.name, url: p.url, access: p.access })),
      history: Array.isArray(raw.history) ? raw.history : [],
      tunnels: Array.isArray(raw.tunnels) ? raw.tunnels : [],
    };
  } catch {
    return null;
  }
}

export async function probe(vm: VmConfig, since = 0): Promise<VmStatus> {
  const t0 = Date.now();
  const sinceSec = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  try {
    const agent = await withVm(vm, async (conn) => {
      const cmd = `if [ -x ${HOSTCTL} ]; then ${HOSTCTL} status ${sinceSec}; else echo NOAGENT; fi`;
      let res = await run(conn, cmd, { timeoutMs: 20_000 });
      let status = parseStatus(res.stdout);
      if (!status || status.v !== AGENT_VERSION) {
        await installAgent(conn);
        res = await run(conn, cmd, { timeoutMs: 20_000 });
        status = parseStatus(res.stdout);
      }
      if (!status) throw new Error(`Agent returned unreadable status: ${(res.stderr || res.stdout).slice(0, 200)}`);
      return status;
    });
    return { name: vm.name, ok: true, ms: Date.now() - t0, checkedAt: Date.now(), agent };
  } catch (e) {
    return {
      name: vm.name,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
      checkedAt: Date.now(),
    };
  }
}

/** Start a detached job on an open connection. `script` is bash run in $HOME. */
export async function startJob(conn: Client, id: string, meta: JobMeta, script: string): Promise<string> {
  if (!JOB_ID_RE.test(id)) throw new Error("bad job id");
  const metaB64 = Buffer.from(JSON.stringify(meta)).toString("base64");
  const res = await run(conn, `${HOSTCTL} job-start ${id} ${metaB64}`, { stdin: script, timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || `job-start exited ${res.code}`);
  return id;
}

export async function jobLog(vm: VmConfig, id: string, bytes = 65536): Promise<JobLog> {
  if (!JOB_ID_RE.test(id)) throw new Error("bad job id");
  return withVm(vm, async (conn) => {
    const res = await run(conn, `${HOSTCTL} job-log ${id} ${Math.min(Math.max(bytes, 1024), 512 * 1024)}`, {
      timeoutMs: 20_000,
      maxBytes: 600 * 1024,
    });
    if (res.code !== 0) throw new Error(res.stderr.trim() || "could not read job log");
    const nl = res.stdout.indexOf("\n");
    const header = res.stdout.slice(0, nl).split(" ");
    const code = Number(header[2]);
    return {
      state: (header[1] as JobLog["state"]) ?? "lost",
      exitCode: Number.isFinite(code) && header[2] !== "null" ? code : null,
      log: res.stdout.slice(nl + 1),
    };
  });
}

export async function killJob(vm: VmConfig, id: string): Promise<void> {
  if (!JOB_ID_RE.test(id)) throw new Error("bad job id");
  await withVm(vm, async (conn) => {
    await run(conn, `${HOSTCTL} job-kill ${id}`, { timeoutMs: 20_000 });
  });
}

export interface ProjectInput {
  name: string;
  repo: string;
  branch: string;
  install: string;
  build: string;
  start: string;
  port: number | null;
  publish: boolean;
  access: "public" | "private";
  category: "app" | "database" | "tool";
  /** null keeps the env file already on the VM. */
  env: Record<string, string> | null;
}

/** Env values written as "generate" become 32 random characters, created here and never shown to the model. */
export function fillGenerated(env: Record<string, string> | null): Record<string, string> | null {
  if (!env) return env;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v.trim().toLowerCase() === "generate") {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      out[k] = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    } else out[k] = v;
  }
  return out;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Write the project files on the VM: manifest (for the UI), conf (for the agent), env (secrets, mode 600). */
export async function saveProject(conn: Client, p: ProjectInput, createdAt?: string): Promise<ProjectManifest> {
  const now = new Date().toISOString();
  const manifest: ProjectManifest = {
    name: p.name,
    repo: p.repo,
    branch: p.branch,
    install: p.install,
    build: p.build,
    start: p.start,
    port: p.port,
    publish: p.publish,
    access: p.access,
    category: p.category,
    envKeys: p.env ? Object.keys(p.env) : [],
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
  const conf = [
    `REPO=${shq(p.repo)}`,
    `BRANCH=${shq(p.branch || "main")}`,
    `INSTALL=${shq(p.install)}`,
    `BUILD=${shq(p.build)}`,
    `START=${shq(p.start)}`,
    `PORT=${shq(p.port ? String(p.port) : "")}`,
    `PUBLISH=${shq(p.publish ? "1" : "0")}`,
    `ACCESS=${shq(p.access)}`,
  ].join("\n");

  const dir = '"$HOME/.hosting/projects"';
  const parts = [`umask 077`, `mkdir -p ${dir}`, `echo ${b64(conf + "\n")} | base64 -d > ${dir}/${p.name}.conf`];
  if (p.env) {
    const envText = Object.entries(p.env)
      .map(([k, v]) => `${k}=${shq(v)}`)
      .join("\n");
    parts.push(`echo ${b64(envText + "\n")} | base64 -d > ${dir}/${p.name}.env`);
  } else {
    // keep existing env keys visible in the manifest
    parts.push(
      `[ -f ${dir}/${p.name}.env ] || : > ${dir}/${p.name}.env`,
    );
    const existing = await run(conn, `cut -d= -f1 ${dir}/${p.name}.env 2>/dev/null || true`, { timeoutMs: 15_000 });
    manifest.envKeys = existing.stdout.split("\n").filter((k) => ENV_KEY_RE.test(k));
  }
  parts.push(`echo ${b64(JSON.stringify(manifest))} | base64 -d > ${dir}/${p.name}.json`);

  await ensureAgent(conn);
  const res = await run(conn, parts.join(" && "), { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || "could not save project");
  return manifest;
}

export async function startDeploy(conn: Client, name: string): Promise<string> {
  const id = newJobId(`deploy-${name}`.slice(0, 40));
  return startJob(
    conn,
    id,
    { label: `deploy ${name}`, kind: "deploy", project: name, startedAt: Math.floor(Date.now() / 1000) },
    `exec ${HOSTCTL} deploy ${name}\n`,
  );
}

export type ProjectAction = "start" | "stop" | "restart" | "logs" | "remove" | "env";

export async function projectAction(vm: VmConfig, name: string, action: ProjectAction): Promise<string> {
  return withVm(vm, async (conn) => {
    await ensureAgent(conn);
    const res = await run(conn, `${HOSTCTL} project ${action} ${name} 300`, { timeoutMs: 40_000 });
    const text = (res.stdout + (res.stderr ? `\n${res.stderr}` : "")).trim();
    if (res.code !== 0) throw new Error(text || `${action} failed`);
    return text;
  });
}
