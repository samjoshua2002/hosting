import type { NextRequest } from "next/server";
import { ENV_KEY_RE, PROJECT_NAME_RE, fillGenerated, saveProject, startDeploy, type ProjectInput } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth, vmsOrThrow } from "@/lib/api";
import { mapLimit, withVm } from "@/lib/ssh";
import { ensureWebhook, getRepo, REPO_RE, webhookUrl } from "@/lib/github";
import type { GithubLink, JobStartResult } from "@/lib/types";
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
  category?: unknown;
  /** "KEY=value" lines; omit or null to keep the env already on the VM. */
  env?: unknown;
  createdAt?: unknown;
  kind?: unknown;
  framework?: unknown;
  /** { repo: "owner/name", autoDeploy } links a GitHub repo; null unlinks; omit to keep. */
  github?: unknown;
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
  // GitHub link: the repo's privacy comes from GitHub, not the browser
  let github: GithubLink | null | undefined;
  if (b.github === null) github = null;
  else if (b.github && typeof b.github === "object") {
    const g = b.github as { repo?: unknown; autoDeploy?: unknown };
    const full = str(g.repo, 140);
    if (!REPO_RE.test(full)) throw new HttpError(400, "github.repo must look like owner/name");
    const info = await getRepo(full).catch((e: Error) => {
      throw new HttpError(400, e.message);
    });
    github = { repo: info.fullName, private: info.private, autoDeploy: g.autoDeploy !== false };
  }
  const repo = str(b.repo, 500) || (github ? `https://github.com/${github.repo}.git` : "");
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
    category: b.category === "database" || b.category === "tool" ? b.category : "app",
    kind: b.kind === "website" || b.kind === "service" || b.kind === "worker" ? b.kind : undefined,
    framework: typeof b.framework === "string" ? str(b.framework, 40) || undefined : undefined,
    github,
    env: typeof b.env === "string" ? fillGenerated(parseEnv(b.env)) : null,
  };
  const createdAt = typeof b.createdAt === "string" ? b.createdAt : undefined;
  audit(req, "project.save", { name, repo, github: github?.repo, targets: vms.map((v) => v.name) });

  let warning: string | undefined;
  if (github?.autoDeploy) {
    try {
      await ensureWebhook(github.repo, webhookUrl(req.nextUrl.origin));
    } catch (e) {
      warning = `Deploying, but auto-deploy isn't set up: ${(e as Error).message}`;
    }
  }

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
  return Response.json({ jobs, warning });
});
