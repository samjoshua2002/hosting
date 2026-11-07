import type { NextRequest } from "next/server";
import { ENV_KEY_RE, PROJECT_NAME_RE, saveProject, startDeploy, type ProjectInput } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth, vmsOrThrow } from "@/lib/api";
import { mapLimit, withVm } from "@/lib/ssh";
import type { JobStartResult } from "@/lib/types";
import { audit } from "@/lib/security";

export const maxDuration = 60;

interface Body {
  targets?: unknown;
  name?: unknown;
  repo?: unknown;
  branch?: unknown;
  install?: unknown;
  build?: unknown;
  start?: unknown;
  port?: unknown;
  publish?: unknown;
  access?: unknown;
  /** "KEY=value" lines; omit or null to keep the env already on the VM. */
  env?: unknown;
  createdAt?: unknown;
}

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    const key = eq > 0 ? t.slice(0, eq).trim() : "";
    if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `Invalid env line: ${t.slice(0, 40)}`);
    let value = t.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

/** POST /api/projects saves (create or update) a project on each target VM and starts a deploy job. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<Body>(req);
  const vms = vmsOrThrow(b.targets);

  const name = str(b.name, 40).toLowerCase();
  if (!PROJECT_NAME_RE.test(name)) throw new HttpError(400, "Name must be lowercase letters, digits and dashes");
  const repo = str(b.repo, 500);
  if (repo && !/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(repo)) throw new HttpError(400, "Repo must be an https:// or git@ URL");
  const branch = str(b.branch, 100) || "main";
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new HttpError(400, "Invalid branch name");
  const port = b.port === null || b.port === "" || b.port === undefined ? null : Number(b.port);
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535))
    throw new HttpError(400, "Port must be between 1024 and 65535");
  const start = str(b.start);
  if (!repo && !start) throw new HttpError(400, "Give a git repo, a start command, or both");

  const input: ProjectInput = {
    name,
    repo,
    branch,
    install: str(b.install),
    build: str(b.build),
    start,
    port,
    publish: Boolean(b.publish) && port !== null,
    access: b.access === "private" ? "private" : "public",
    env: typeof b.env === "string" ? parseEnv(b.env) : null,
  };
  const createdAt = typeof b.createdAt === "string" ? b.createdAt : undefined;
  audit(req, "project.save", { name, repo, targets: vms.map((v) => v.name) });

  const jobs = await mapLimit(vms, 16, async (vm): Promise<JobStartResult> => {
    try {
      const id = await withVm(vm, async (conn) => {
        await saveProject(conn, input, createdAt);
        return startDeploy(conn, name);
      });
      return { vm: vm.name, id };
    } catch (e) {
      return { vm: vm.name, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return Response.json({ jobs });
});
