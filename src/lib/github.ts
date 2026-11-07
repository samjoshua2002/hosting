// GitHub connection: a token (from GITHUB_TOKEN, or pasted in the dashboard and kept encrypted on the
// storage machine), repo listing, framework detection, and push webhooks for auto-deploy.
// The token never goes to the browser; machines only get it for the length of one private-repo deploy.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { storeDelete, storeGetJson, storePut } from "./store";

import { REPO_RE } from "./github-shared";
export { REPO_RE, repoFromUrl } from "./github-shared";
const STORE_PATH = "github/auth.json";
const API = "https://api.github.com";

export interface GithubAuth {
  token: string;
  login: string;
  scopes: string[];
  source: "env" | "dashboard";
}

interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  data: string;
  login: string;
  scopes: string[];
  savedAt: string;
}

function secret(): string {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 16) throw new Error("SESSION_SECRET is not set");
  return s;
}

function sealKey(): Buffer {
  return createHash("sha256").update(`${secret()}:github-token:v1`).digest();
}

function seal(token: string): Pick<Sealed, "iv" | "tag" | "data"> {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(), iv);
  const data = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function unseal(s: Sealed): string {
  const d = createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
}

let cached: { at: number; auth: GithubAuth | null } | null = null;

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hosting-dashboard",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

async function whoami(token: string): Promise<{ login: string; scopes: string[] }> {
  const r = await call(token, "/user");
  if (r.status === 401) throw new Error("GitHub rejected this token");
  if (!r.ok) throw new Error(`GitHub /user failed (${r.status})`);
  const u = (await r.json()) as { login: string };
  const scopes = (r.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { login: u.login, scopes };
}

/** The connected account, or null. Cached for a few minutes per server instance. */
export async function githubAuth(fresh = false): Promise<GithubAuth | null> {
  if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.auth;
  let auth: GithubAuth | null = null;
  const env = process.env.GITHUB_TOKEN?.trim();
  if (env) {
    const who = await whoami(env).catch(() => ({ login: "unknown", scopes: [] }));
    auth = { token: env, ...who, source: "env" };
  } else {
    const s = await storeGetJson<Sealed>(STORE_PATH).catch(() => null);
    if (s?.v === 1) {
      try {
        auth = { token: unseal(s), login: s.login, scopes: s.scopes, source: "dashboard" };
      } catch {
        auth = null; // SESSION_SECRET changed: reconnect
      }
    }
  }
  cached = { at: Date.now(), auth };
  return auth;
}

export async function githubToken(): Promise<string> {
  const a = await githubAuth();
  if (!a) throw new Error("GitHub is not connected. Connect it on the Projects page.");
  return a.token;
}

export async function connectGithub(token: string): Promise<GithubAuth> {
  const t = token.trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) throw new Error("That doesn't look like a GitHub token");
  const who = await whoami(t);
  await storePut(STORE_PATH, JSON.stringify({ v: 1, ...seal(t), login: who.login, scopes: who.scopes, savedAt: new Date().toISOString() } satisfies Sealed));
  cached = null;
  return { token: t, ...who, source: "dashboard" };
}

export async function disconnectGithub(): Promise<void> {
  await storeDelete(STORE_PATH);
  cached = null;
}

/** Classic tokens list their scopes; fine-grained ones don't (empty list), so only warn for classic. */
export function missingScopes(scopes: string[]): string[] {
  if (!scopes.length) return [];
  const miss: string[] = [];
  if (!scopes.includes("repo") && !scopes.includes("public_repo")) miss.push("repo");
  if (!scopes.includes("admin:repo_hook") && !scopes.includes("write:repo_hook") && !scopes.includes("repo")) miss.push("admin:repo_hook");
  return miss;
}

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
  url: string;
}

export async function listRepos(): Promise<Repo[]> {
  const token = await githubToken();
  const out: Repo[] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await call(token, `/user/repos?per_page=100&sort=pushed&page=${page}&affiliation=owner,collaborator,organization_member`);
    if (!r.ok) throw new Error(`GitHub repo list failed (${r.status})`);
    const list = (await r.json()) as {
      full_name: string;
      private: boolean;
      default_branch: string;
      description: string | null;
      language: string | null;
      pushed_at: string | null;
      html_url: string;
      archived: boolean;
    }[];
    for (const x of list)
      if (!x.archived)
        out.push({ fullName: x.full_name, private: x.private, defaultBranch: x.default_branch, description: x.description, language: x.language, pushedAt: x.pushed_at, url: x.html_url });
    if (list.length < 100) break;
  }
  return out;
}

export async function getRepo(fullName: string): Promise<Repo> {
  if (!REPO_RE.test(fullName)) throw new Error("repo must look like owner/name");
  const r = await call(await githubToken(), `/repos/${fullName}`);
  if (r.status === 404) throw new Error(`${fullName} not found, or the token can't see it`);
  if (!r.ok) throw new Error(`GitHub ${fullName} failed (${r.status})`);
  const x = (await r.json()) as { full_name: string; private: boolean; default_branch: string; description: string | null; language: string | null; pushed_at: string | null; html_url: string };
  return { fullName: x.full_name, private: x.private, defaultBranch: x.default_branch, description: x.description, language: x.language, pushedAt: x.pushed_at, url: x.html_url };
}

export interface Detected {
  framework: string;
  kind: "website" | "service" | "worker";
  install: string;
  build: string;
  start: string;
  port: string;
  publish: boolean;
}

async function file(token: string, repo: string, path: string, ref: string): Promise<string | null> {
  const r = await call(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!r.ok) return null;
  const t = await r.text();
  return t.slice(0, 200_000);
}

/** Look at the repo root and guess how to build and run it. */
export async function detectFramework(repo: string, ref: string): Promise<Detected> {
  const token = await githubToken();
  const r = await call(token, `/repos/${repo}/contents/?ref=${encodeURIComponent(ref)}`);
  const names = r.ok ? ((await r.json()) as { name: string }[]).map((x) => x.name) : [];
  const has = (n: string) => names.includes(n);
  const lock = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
  const install = { npm: "npm ci || npm install", pnpm: "npx --yes pnpm install --frozen-lockfile", yarn: "npx --yes yarn install --frozen-lockfile", bun: "npx --yes bun install" }[lock];
  const run = (s: string) => (lock === "npm" ? `npm run ${s}` : `npx --yes ${lock} run ${s}`);

  if (has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yml") || has("compose.yaml"))
    return { framework: "Docker Compose", kind: "service", install: "", build: "docker compose build", start: "exec docker compose up", port: "8080", publish: true };

  if (has("package.json")) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse((await file(token, repo, "package.json", ref)) ?? "{}");
    } catch {}
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const d = (n: string) => n in deps;
    const scripts = pkg.scripts ?? {};
    const build = scripts.build ? run("build") : "";
    if (d("next")) return { framework: "Next.js", kind: "website", install, build, start: "npx next start -p $PORT", port: "3000", publish: true };
    if (d("nuxt")) return { framework: "Nuxt", kind: "website", install, build, start: "node .output/server/index.mjs", port: "3000", publish: true };
    if (d("@remix-run/serve") || d("@react-router/serve")) return { framework: "Remix", kind: "website", install, build, start: run("start"), port: "3000", publish: true };
    if (d("@sveltejs/kit")) return { framework: "SvelteKit", kind: "website", install, build, start: "node build", port: "3000", publish: true };
    if (d("astro")) return { framework: "Astro", kind: "website", install, build, start: "npx --yes serve -s dist -l $PORT", port: "8080", publish: true };
    if (d("react-scripts")) return { framework: "Create React App", kind: "website", install, build, start: "npx --yes serve -s build -l $PORT", port: "8080", publish: true };
    if (d("vite")) return { framework: "Vite", kind: "website", install, build, start: "npx --yes serve -s dist -l $PORT", port: "8080", publish: true };
    const api = ["@nestjs/core", "express", "fastify", "koa", "hono", "@hapi/hapi"].find(d);
    if (api || scripts.start)
      return { framework: api ? { "@nestjs/core": "NestJS", express: "Express", fastify: "Fastify", koa: "Koa", hono: "Hono", "@hapi/hapi": "hapi" }[api] ?? "Node.js" : "Node.js", kind: "service", install, build, start: scripts.start ? run("start") : "node index.js", port: "3000", publish: true };
    return { framework: "Node.js", kind: "worker", install, build, start: "node index.js", port: "", publish: false };
  }

  if (has("requirements.txt") || has("pyproject.toml")) {
    const req = ((await file(token, repo, "requirements.txt", ref)) ?? "") + ((await file(token, repo, "pyproject.toml", ref)) ?? "");
    const pyInstall = has("requirements.txt") ? "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" : "python3 -m venv .venv && .venv/bin/pip install .";
    const entry = has("main.py") ? "main" : has("app.py") ? "app" : "main";
    if (/fastapi/i.test(req)) return { framework: "FastAPI", kind: "service", install: pyInstall, build: "", start: `.venv/bin/python -m uvicorn ${entry}:app --host 0.0.0.0 --port $PORT`, port: "8000", publish: true };
    if (/django/i.test(req)) return { framework: "Django", kind: "website", install: pyInstall, build: "", start: ".venv/bin/python manage.py runserver 0.0.0.0:$PORT", port: "8000", publish: true };
    if (/flask/i.test(req)) return { framework: "Flask", kind: "service", install: `${pyInstall} && .venv/bin/pip install gunicorn`, build: "", start: `.venv/bin/gunicorn -b 0.0.0.0:$PORT ${entry}:app`, port: "8000", publish: true };
    if (/streamlit/i.test(req)) return { framework: "Streamlit", kind: "website", install: pyInstall, build: "", start: `.venv/bin/streamlit run ${entry}.py --server.port $PORT --server.address 0.0.0.0`, port: "8501", publish: true };
    return { framework: "Python", kind: "worker", install: pyInstall, build: "", start: `.venv/bin/python ${entry}.py`, port: "", publish: false };
  }

  if (has("go.mod")) return { framework: "Go", kind: "service", install: "", build: "go build -o app .", start: "./app", port: "8080", publish: true };

  if (has("Dockerfile")) {
    const df = (await file(token, repo, "Dockerfile", ref)) ?? "";
    const expose = df.match(/^\s*EXPOSE\s+(\d+)/im)?.[1] ?? "80";
    const tag = repo.split("/")[1].toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return { framework: "Dockerfile", kind: "service", install: "", build: `docker build -t ${tag} .`, start: `docker rm -f ${tag}-$PORT >/dev/null 2>&1; exec docker run --name ${tag}-$PORT -p $PORT:${expose} ${tag}`, port: "8080", publish: true };
  }

  if (has("index.html")) return { framework: "Static HTML", kind: "website", install: "", build: "", start: "npx --yes serve -s . -l $PORT", port: "8080", publish: true };

  return { framework: "Unknown", kind: "service", install: "", build: "", start: "", port: "", publish: false };
}

/** Webhook secret derived from SESSION_SECRET, so nothing extra needs storing. */
export function webhookSecret(): string {
  return createHmac("sha256", secret()).update("github-webhook:v1").digest("hex");
}

export function verifyWebhook(raw: string, signature: string | null): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const want = Buffer.from(createHmac("sha256", webhookSecret()).update(raw).digest("hex"));
  const got = Buffer.from(signature.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Public address GitHub should call. APP_URL wins, then Vercel's production domain. */
export function webhookUrl(fallbackOrigin: string): string {
  const base = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : fallbackOrigin);
  return `${base.replace(/\/$/, "")}/api/github/webhook`;
}

/** Create (or refresh) the push webhook on a repo. Idempotent. */
export async function ensureWebhook(repo: string, url: string): Promise<void> {
  if (!REPO_RE.test(repo)) throw new Error("bad repo");
  const token = await githubToken();
  const config = { url, content_type: "json", secret: webhookSecret(), insecure_ssl: "0" };
  const list = await call(token, `/repos/${repo}/hooks?per_page=100`);
  if (list.status === 404 || list.status === 403) throw new Error(`no permission to add webhooks on ${repo} (token needs admin:repo_hook)`);
  if (!list.ok) throw new Error(`GitHub hooks list failed (${list.status})`);
  const hooks = (await list.json()) as { id: number; config: { url?: string } }[];
  const mine = hooks.find((h) => h.config.url === url);
  const r = mine
    ? await call(token, `/repos/${repo}/hooks/${mine.id}`, { method: "PATCH", body: JSON.stringify({ active: true, events: ["push"], config }) })
    : await call(token, `/repos/${repo}/hooks`, { method: "POST", body: JSON.stringify({ name: "web", active: true, events: ["push"], config }) });
  if (!r.ok) throw new Error(`GitHub webhook ${mine ? "update" : "create"} failed (${r.status})`);
}
