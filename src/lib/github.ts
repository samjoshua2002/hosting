// GitHub connection: a token (from GITHUB_TOKEN, or pasted in the dashboard and kept encrypted on the
// storage machine), repo listing, framework detection, and push webhooks for auto-deploy.
// The token never goes to the browser; machines only get it for the length of one private-repo deploy.
import { createHmac, timingSafeEqual } from "node:crypto";
import { unifiedDiff } from "./diff";
import { hasScope } from "./github-scopes";
import { seal, unseal } from "./seal";
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

const PURPOSE = "github-token:v1"; // same key as before, so saved tokens keep working

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
        auth = { token: unseal(s, PURPOSE), login: s.login, scopes: s.scopes, source: "dashboard" };
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
  await storePut(STORE_PATH, JSON.stringify({ v: 1, ...seal(t, PURPOSE), login: who.login, scopes: who.scopes, savedAt: new Date().toISOString() } satisfies Sealed));
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
  if (!hasScope(scopes, "repo") && !hasScope(scopes, "public_repo")) miss.push("repo");
  if (!hasScope(scopes, "write:repo_hook")) miss.push("admin:repo_hook");
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

  if (has("go.mod"))
    return {
      framework: "Go",
      kind: "service",
      install: "command -v go >/dev/null || (sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq golang)",
      build: "go build -o app .",
      start: "./app",
      port: "8080",
      publish: true,
    };

  // Java: Maven or Gradle (wrapper preferred), Spring Boot gets its port from --server.port
  const jdk = "command -v java >/dev/null || (sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq default-jdk-headless)";
  if (has("pom.xml")) {
    const pom = (await file(token, repo, "pom.xml", ref)) ?? "";
    const spring = /spring-boot/.test(pom);
    const wrapper = has("mvnw");
    return {
      framework: spring ? "Spring Boot (Maven)" : "Java (Maven)",
      kind: "service",
      install: wrapper ? `${jdk} && chmod +x mvnw` : "command -v mvn >/dev/null || (sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq default-jdk-headless maven)",
      build: `${wrapper ? "./mvnw" : "mvn"} -q -B -DskipTests package`,
      start: `exec java -jar "$(ls target/*.jar | grep -v -e '-sources' -e '-javadoc' -e 'original-' | head -n 1)"${spring ? " --server.port=$PORT" : ""}`,
      port: "8080",
      publish: true,
    };
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    const g = ((await file(token, repo, "build.gradle", ref)) ?? "") + ((await file(token, repo, "build.gradle.kts", ref)) ?? "");
    const spring = /org\.springframework\.boot/.test(g);
    const wrapper = has("gradlew");
    return {
      framework: spring ? "Spring Boot (Gradle)" : "Java (Gradle)",
      kind: "service",
      install: wrapper ? `${jdk} && chmod +x gradlew` : "command -v gradle >/dev/null || (sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq default-jdk-headless gradle)",
      build: `${wrapper ? "./gradlew" : "gradle"} -q build -x test`,
      start: `exec java -jar "$(ls build/libs/*.jar | grep -v -e '-plain' -e '-sources' | head -n 1)"${spring ? " --server.port=$PORT" : ""}`,
      port: "8080",
      publish: true,
    };
  }

  if (has("Cargo.toml")) {
    const cargo = (await file(token, repo, "Cargo.toml", ref)) ?? "";
    const bin = cargo.match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/)?.[1] ?? "app";
    const env = '. "$HOME/.cargo/env" 2>/dev/null;';
    return {
      framework: "Rust",
      kind: "service",
      install: `command -v cargo >/dev/null || [ -x "$HOME/.cargo/bin/cargo" ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal)`,
      build: `${env} cargo build --release`,
      start: `exec ./target/release/${bin}`,
      port: "8080",
      publish: true,
    };
  }

  if (has("composer.json") || has("index.php") || has("artisan")) {
    const laravel = has("artisan");
    // php plus the MySQL/Postgres drivers (mysqli, pdo_mysql, pdo_pgsql), installed once
    const php =
      "php -m 2>/dev/null | grep -qi '^mysqli$' || (sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq php-cli php-mysql php-pgsql php-sqlite3 php-mbstring php-xml php-curl php-zip php-gd php-intl unzip)";
    const composer = has("composer.json")
      ? ' && (command -v composer >/dev/null || (mkdir -p "$HOME/.local/bin" && curl -sS https://getcomposer.org/installer | php -- --install-dir="$HOME/.local/bin" --filename=composer)) && PATH="$HOME/.local/bin:$PATH" composer install --no-dev --no-interaction'
      : "";
    return {
      framework: laravel ? "Laravel" : "PHP",
      kind: "website",
      install: php + composer,
      build: laravel ? "[ -f .env ] || cp .env.example .env; php artisan key:generate --force || true" : "",
      start: laravel ? "exec php artisan serve --host=0.0.0.0 --port=$PORT" : `exec php -S 0.0.0.0:$PORT -t ${has("public") ? "public" : "."}`,
      port: "8000",
      publish: true,
    };
  }

  if (has("Gemfile")) {
    const gems = (await file(token, repo, "Gemfile", ref)) ?? "";
    const rails = /gem ["']rails["']/.test(gems);
    return {
      framework: rails ? "Ruby on Rails" : "Ruby",
      kind: rails ? "website" : "service",
      install: "command -v bundle >/dev/null || (sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ruby-full build-essential libyaml-dev); bundle config set --local path vendor/bundle && bundle install",
      build: rails ? "RAILS_ENV=production bundle exec rails assets:precompile || true" : "",
      start: rails ? "exec bundle exec rails server -b 0.0.0.0 -p $PORT -e production" : "exec bundle exec rackup -o 0.0.0.0 -p $PORT",
      port: "3000",
      publish: true,
    };
  }

  const csproj = names.find((n) => n.endsWith(".csproj"));
  if (csproj) {
    const dn = '"$HOME/.dotnet/dotnet"';
    return {
      framework: ".NET",
      kind: "service",
      install: `[ -x ${dn} ] || (curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0)`,
      build: `${dn} publish -c Release -o out`,
      start: `ASPNETCORE_URLS=http://0.0.0.0:$PORT exec ${dn} out/${csproj.replace(/\.csproj$/, "")}.dll`,
      port: "8080",
      publish: true,
    };
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

  if (has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yml") || has("compose.yaml"))
    return { framework: "Docker Compose", kind: "service", install: "", build: "docker compose build", start: "exec docker compose up", port: "8080", publish: true };

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

// ---- working on code (the Assistant's workspace tools) ----

export async function listBranches(repo: string): Promise<{ name: string; protected: boolean }[]> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  const r = await call(await githubToken(), `/repos/${repo}/branches?per_page=100`);
  if (!r.ok) throw new Error(`GitHub branches failed (${r.status})`);
  return ((await r.json()) as { name: string; protected: boolean }[]).map((b) => ({ name: b.name, protected: b.protected }));
}

async function refSha(token: string, repo: string, branch: string): Promise<string | null> {
  const r = await call(token, `/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
  // 409 = the repository has no commits yet (no branches at all)
  if (r.status === 404 || r.status === 409) return null;
  if (!r.ok) throw new Error(`GitHub ref ${branch} failed (${r.status})`);
  return ((await r.json()) as { object: { sha: string } }).object.sha;
}

const SKIP = /(^|\/)(node_modules|\.git|\.next|dist|build|out|\.venv|venv|__pycache__|vendor|coverage)\//;

/** File paths in the repo (skips dependency and build folders). */
export async function repoTree(repo: string, ref: string, prefix = ""): Promise<{ paths: string[]; truncated: boolean }> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  const r = await call(await githubToken(), `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!r.ok) throw new Error(`GitHub tree failed (${r.status})`);
  const t = (await r.json()) as { tree: { path: string; type: string }[]; truncated: boolean };
  const p = prefix.replace(/^\/+/, "");
  const paths = t.tree.filter((x) => x.type === "blob" && !SKIP.test(x.path) && (!p || x.path.startsWith(p))).map((x) => x.path);
  return { paths: paths.slice(0, 800), truncated: t.truncated || paths.length > 800 };
}

export async function readRepoFile(repo: string, ref: string, path: string): Promise<string | null> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  return file(await githubToken(), repo, path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/"), ref);
}

export interface FileChange {
  path: string;
  /** full new content */
  content?: string;
  /** or exact find/replace edits on the current content (each find must match exactly once) */
  edits?: { find: string; replace: string }[];
  delete?: boolean;
}

export interface Plan {
  repo: string;
  branch: string;
  /** branch doesn't exist yet: it is created from base */
  createFrom: string | null;
  /** the repository has no commits yet: the first commit creates its default branch */
  empty?: boolean;
  files: { path: string; before: string | null; after: string | null }[];
}

/** Work out the new file contents (without writing anything). */
export async function planChanges(repo: string, branch: string, base: string | undefined, changes: FileChange[]): Promise<Plan> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes("..")) throw new Error("bad branch name");
  if (!changes.length) throw new Error("no file changes");
  if (changes.length > 40) throw new Error("too many files in one commit (max 40)");
  const token = await githubToken();
  const exists = await refSha(token, repo, branch);
  let createFrom: string | null = null;
  let empty = false;
  if (!exists) {
    createFrom = base || (await getRepo(repo)).defaultBranch;
    if (!(await refSha(token, repo, createFrom))) {
      // a brand-new repository with no commits: nothing to branch from, the first commit starts it
      if (!(await repoIsEmpty(token, repo))) throw new Error(`base branch ${createFrom} not found`);
      empty = true;
      createFrom = null;
    }
  }
  const readRef = exists ? branch : createFrom;
  const files: Plan["files"] = [];
  for (const c of changes) {
    const path = String(c.path ?? "").replace(/^\/+/, "");
    if (!path || path.includes("..") || path.startsWith(".git/")) throw new Error(`bad path ${path}`);
    const before = readRef ? await file(token, repo, path.split("/").map(encodeURIComponent).join("/"), readRef) : null;
    let after: string | null;
    if (c.delete) after = null;
    else if (typeof c.content === "string") after = c.content;
    else if (Array.isArray(c.edits) && c.edits.length) {
      if (before === null) throw new Error(`${path} doesn't exist; give its full content instead of edits`);
      after = before;
      for (const [k, e] of c.edits.entries()) {
        if (!e || typeof e.find !== "string" || typeof e.replace !== "string")
          throw new Error(`${path}: edit ${k + 1} of ${c.edits.length} is malformed (each edit needs "find" and "replace" text). Send valid edits, or the file's full new content instead.`);
        const n = after.split(e.find).length - 1;
        if (!e.find || n === 0) throw new Error(`${path}: text to replace not found: ${String(e.find).slice(0, 80)}`);
        if (n > 1) throw new Error(`${path}: text to replace appears ${n} times; include more surrounding lines`);
        after = after.replace(e.find, () => e.replace);
      }
    } else throw new Error(`${path}: give content, edits or delete`);
    files.push({ path, before, after });
  }
  return { repo, branch, createFrom, files, ...(empty ? { empty } : {}) };
}

/** True when the repository exists but has no commits (GitHub answers 409 for its commit list). */
async function repoIsEmpty(token: string, repo: string): Promise<boolean> {
  const r = await call(token, `/repos/${repo}/commits?per_page=1`);
  return r.status === 409;
}

/**
 * The first commit of an empty repository. GitHub's Git Data API can't create a ref there, but the
 * Contents API can: write one file (this creates the default branch), then the rest is a normal commit.
 * A just-created repository can answer 409 for a few seconds, so this retries with backoff.
 */
async function startEmptyRepo(token: string, p: Plan, message: string): Promise<{ head: string; branch: string; rest: Plan["files"] }> {
  const first = p.files.find((f) => f.after !== null);
  if (!first) throw new Error("the repository is empty: the first commit needs at least one file with content");
  const path = first.path.split("/").map(encodeURIComponent).join("/");
  const body = JSON.stringify({ message: message.slice(0, 2000), content: Buffer.from(first.after!, "utf8").toString("base64") });
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    const r = await call(token, `/repos/${p.repo}/contents/${path}`, { method: "PUT", body });
    if (r.ok) {
      const head = ((await r.json()) as { commit: { sha: string } }).commit.sha;
      const branch = (await getRepo(p.repo)).defaultBranch;
      return { head, branch, rest: p.files.filter((f) => f !== first) };
    }
    last = `${r.status}: ${(await r.text()).slice(0, 200)}`;
    if (r.status !== 409 && r.status !== 404 && r.status < 500) break;
  }
  throw new Error(`GitHub couldn't start the empty repository (${last})`);
}

export function planDiff(p: Plan): string {
  const head = p.empty ? `First commit of the empty repository (starts ${p.branch})` : p.createFrom ? `New branch ${p.branch} from ${p.createFrom}` : `Branch ${p.branch}`;
  return [head, ...p.files.map((f) => unifiedDiff(f.path, f.before, f.after))].join("\n\n");
}

/** One commit with all the changes (Git Data API); creates the branch if needed. */
export async function commitPlan(p: Plan, message: string): Promise<{ sha: string; url: string; branch: string; created: boolean }> {
  const token = await githubToken();
  if (p.empty) {
    // first commit of a new repository: start it with one file, then commit the rest on top
    const start = await startEmptyRepo(token, p, message);
    const onDefault = start.branch === p.branch;
    if (!start.rest.length && onDefault) return { sha: start.head, url: `https://github.com/${p.repo}/commit/${start.head}`, branch: p.branch, created: true };
    const next: Plan = { repo: p.repo, branch: p.branch, createFrom: onDefault ? null : start.branch, files: start.rest };
    if (!next.files.length) next.files = [];
    const r = next.files.length ? await commitPlan(next, message) : await branchFrom(token, p.repo, p.branch, start.head);
    return { ...r, created: true };
  }
  const head = (await refSha(token, p.repo, p.branch)) ?? (await refSha(token, p.repo, p.createFrom ?? ""));
  if (!head) throw new Error("branch to commit on is gone");
  const commit = (await (await call(token, `/repos/${p.repo}/git/commits/${head}`)).json()) as { tree: { sha: string } };
  // keep the executable bit of files that have it
  const treeRes = await call(token, `/repos/${p.repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const modes = new Map<string, string>();
  if (treeRes.ok) for (const x of ((await treeRes.json()) as { tree: { path: string; mode: string }[] }).tree) modes.set(x.path, x.mode);
  const tree = p.files.map((f) =>
    f.after === null ? { path: f.path, mode: modes.get(f.path) ?? "100644", type: "blob", sha: null } : { path: f.path, mode: modes.get(f.path) ?? "100644", type: "blob", content: f.after },
  );
  const t = await call(token, `/repos/${p.repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
  if (!t.ok) throw new Error(`GitHub tree write failed (${t.status}): ${(await t.text()).slice(0, 200)}`);
  const c = await call(token, `/repos/${p.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: message.slice(0, 2000), tree: ((await t.json()) as { sha: string }).sha, parents: [head] }),
  });
  if (!c.ok) throw new Error(`GitHub commit failed (${c.status})`);
  const sha = ((await c.json()) as { sha: string }).sha;
  const created = Boolean(p.createFrom) && !(await refSha(token, p.repo, p.branch));
  const ref = created
    ? await call(token, `/repos/${p.repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${p.branch}`, sha }) })
    : await call(token, `/repos/${p.repo}/git/refs/heads/${p.branch}`, { method: "PATCH", body: JSON.stringify({ sha, force: false }) });
  if (!ref.ok) {
    const why = (await ref.text()).slice(0, 200);
    throw new Error(ref.status === 404 || ref.status === 403 ? `GitHub refused the push (${ref.status}); workflow files need the workflow scope. ${why}` : `GitHub branch update failed (${ref.status}): ${why}`);
  }
  return { sha, url: `https://github.com/${p.repo}/commit/${sha}`, branch: p.branch, created };
}

/** Point a new branch at a commit. */
async function branchFrom(token: string, repo: string, branch: string, sha: string): Promise<{ sha: string; url: string; branch: string; created: boolean }> {
  const r = await call(token, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
  if (!r.ok) throw new Error(`GitHub branch create failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return { sha, url: `https://github.com/${repo}/commit/${sha}`, branch, created: true };
}

export async function openPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<{ number: number; url: string }> {
  const r = await call(await githubToken(), `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ head, base, title: title.slice(0, 250), body: body.slice(0, 20000) }) });
  if (!r.ok) throw new Error(`GitHub pull request failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const pr = (await r.json()) as { number: number; html_url: string };
  return { number: pr.number, url: pr.html_url };
}

/** Writes that always need the user's OK, whatever the review mode. */
export function sensitiveGithubCall(method: string, path: string): boolean {
  if (method === "DELETE") return true;
  if (method === "GET") return false;
  return /^\/(user\/(keys|gpg_keys|ssh_signing_keys|emails)|orgs\/[^/]+\/(members|memberships|teams|hooks|actions\/secrets)|repos\/[^/]+\/[^/]+\/(collaborators|keys|actions\/secrets|dependabot\/secrets|environments|transfer|branches\/[^/]+\/protection))/.test(path) ||
    /^\/repos\/[^/]+\/[^/]+\/?$/.test(path); // PATCH on the repo itself: rename, visibility, archive
}

/** Any GitHub REST call the token allows. Output is trimmed JSON. */
export async function githubApi(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  if (!/^\/[A-Za-z0-9._~\-/%?=&,:+@]*$/.test(path) || path.includes("..")) throw new Error("path must be a GitHub API path like /repos/owner/name/issues");
  const r = await call(await githubToken(), path, { method, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text: text.slice(0, 12000) };
}

/** Any GitHub REST call with the stored token, full response text (for code that parses the JSON). */
export async function githubApiRaw(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const r = await call(await githubToken(), path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  return { status: r.status, text: await r.text() };
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
  "video/mp4": "mp4", "video/webm": "webm", "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf", "application/font-woff2": "woff2", "application/json": "json",
};

/**
 * Download files from the web and commit them into a repo in one commit (binary-safe, via Git blobs).
 * Used to bring a cloned site's images, SVG files, videos and fonts into the clone.
 */
export async function importAssets(repo: string, branch: string | undefined, urls: string[], dir = "public/assets"): Promise<{ saved: { url: string; path: string; web?: string }[]; summary: string }> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  const folder = dir.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(folder) || folder.includes("..")) throw new Error("bad dir");
  const list = [...new Set(urls)].slice(0, 80);
  if (!list.length) throw new Error("no urls");
  const token = await githubToken();
  const br = branch || (await getRepo(repo)).defaultBranch;
  const head = await refSha(token, repo, br);
  if (!head) throw new Error(`branch ${br} has no commits yet: commit the project's files first, then import assets`);

  const PER = 8 * 1024 * 1024;
  const TOTAL = 60 * 1024 * 1024;
  let total = 0;
  const used = new Set<string>();
  const got: { url: string; name: string; data: Buffer }[] = [];
  const failed: string[] = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const url = list[i++];
      try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; hosting-dashboard)", Accept: "*/*" }, signal: AbortSignal.timeout(25_000), redirect: "follow" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const len = Number(r.headers.get("content-length") || 0);
        if (len > PER) throw new Error("larger than 8 MB");
        const data = Buffer.from(await r.arrayBuffer());
        if (data.length > PER) throw new Error("larger than 8 MB");
        if (total + data.length > TOTAL) throw new Error("over the 60 MB total");
        total += data.length;
        const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        let base = decodeURIComponent(new URL(url).pathname.split("/").pop() || "asset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "asset";
        // Next.js image URLs (/_next/image?url=...) and extensionless CDN paths: name from the content type
        if (!/\.[a-z0-9]{2,5}$/i.test(base) && EXT_BY_TYPE[type]) base = `${base}.${EXT_BY_TYPE[type]}`;
        let name = base;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = base.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${n}${ext}`);
        used.add(name.toLowerCase());
        got.push({ url, name, data });
      } catch (e) {
        failed.push(`${url}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (!got.length) return { saved: [], summary: `Nothing downloaded.\n${failed.join("\n")}` };

  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const g of got) {
    const b = await call(token, `/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: g.data.toString("base64"), encoding: "base64" }) });
    if (!b.ok) {
      failed.push(`${g.url}: GitHub blob failed (${b.status})`);
      continue;
    }
    tree.push({ path: `${folder}/${g.name}`, mode: "100644", type: "blob", sha: ((await b.json()) as { sha: string }).sha });
  }
  const base = (await (await call(token, `/repos/${repo}/git/commits/${head}`)).json()) as { tree: { sha: string } };
  const t = await call(token, `/repos/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  if (!t.ok) throw new Error(`GitHub tree write failed (${t.status}): ${(await t.text()).slice(0, 200)}`);
  const c = await call(token, `/repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message: `Add ${tree.length} assets to ${folder}`, tree: ((await t.json()) as { sha: string }).sha, parents: [head] }) });
  if (!c.ok) throw new Error(`GitHub commit failed (${c.status})`);
  const sha = ((await c.json()) as { sha: string }).sha;
  const ref = await call(token, `/repos/${repo}/git/refs/heads/${br}`, { method: "PATCH", body: JSON.stringify({ sha, force: false }) });
  if (!ref.ok) throw new Error(`GitHub branch update failed (${ref.status}): ${(await ref.text()).slice(0, 200)}`);
  const web = (p: string) => (p.startsWith("public/") ? `/${p.slice("public/".length)}` : undefined);
  const saved = got.filter((g) => tree.some((x) => x.path === `${folder}/${g.name}`)).map((g) => ({ url: g.url, path: `${folder}/${g.name}`, web: web(`${folder}/${g.name}`) }));
  const summary = [
    `Committed ${saved.length} files (${Math.round(total / 1024)} KB) to ${repo}@${br}: https://github.com/${repo}/commit/${sha}`,
    ...saved.map((s) => `${s.url} -> ${s.path}${s.web ? ` (use "${s.web}" in the code)` : ""}`),
    ...(failed.length ? ["Not downloaded:", ...failed] : []),
  ].join("\n");
  return { saved, summary };
}

/**
 * A new repository from a GitHub template repository (e.g. JCodesMore/ai-website-cloner-template), owned by the
 * connected account. GitHub fills it in the background, so this waits (up to ~40 s) until its default branch exists.
 */
export async function createFromTemplate(template: string, name: string, isPrivate = true): Promise<{ repo: string; branch: string; url: string }> {
  if (!REPO_RE.test(template)) throw new Error("template must look like owner/name");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error("repo name: letters, numbers, . _ - only");
  const token = await githubToken();
  const auth = await githubAuth();
  if (!auth) throw new Error("GitHub is not connected");
  const r = await call(token, `/repos/${template}/generate`, { method: "POST", body: JSON.stringify({ owner: auth.login, name, private: isPrivate, include_all_branches: false }) });
  if (r.status === 422 && /already exists/i.test(await r.clone().text())) throw new Error(`${auth.login}/${name} already exists: pick another name or use that repo`);
  if (!r.ok) throw new Error(`GitHub couldn't create the repo from ${template} (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const made = (await r.json()) as { full_name: string; default_branch?: string; html_url: string };
  const branch = made.default_branch || (await getRepo(template)).defaultBranch;
  for (let i = 0; i < 20; i++) {
    if (await refSha(token, made.full_name, branch)) return { repo: made.full_name, branch, url: made.html_url };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { repo: made.full_name, branch, url: made.html_url };
}
