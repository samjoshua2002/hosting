// Turn a zipped project the user attached into a GitHub repository (one commit), so it can be deployed and
// worked on like any other repo. Unzips on the server, leaves out what doesn't belong in git (dependencies,
// build output, OS junk) and never commits .env files: their values go to the secrets vault instead.
import { unzipSync } from "fflate";
import { githubApiRaw, githubAuth } from "./github";
import { vaultText } from "./vault";

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // GitHub's blob limit is 100 MB; anything this big shouldn't be in git
const MAX_TOTAL = 80 * 1024 * 1024;
const SKIP_DIR = /(^|\/)(node_modules|\.git|__MACOSX|\.next|\.nuxt|\.svelte-kit|\.turbo|\.vercel|dist|build|out|target|vendor\/bundle|\.venv|venv|env|__pycache__|\.pytest_cache|\.mypy_cache|\.gradle|\.idea|\.vscode|coverage|\.cache|\.parcel-cache|bower_components)\//;
const SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|npm-debug\.log.*|yarn-error\.log|.*\.pyc|.*\.class|.*\.log)$/i;
const ENV_FILE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;
const EXAMPLE_ENV = /\.env\.(example|sample|template|dist)$/i;

export interface ZipImportResult {
  repo: string;
  url: string;
  branch: string;
  files: number;
  skipped: { path: string; why: string }[];
  envFiles: { path: string; secrets: string[] }[];
  root: string | null;
}

/** What's in the zip, before anything is created: for the approval preview and quick checks. */
export function inspectZip(data: Buffer): { files: { path: string; size: number }[]; skipped: { path: string; why: string }[]; env: string[]; root: string | null } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(data), { filter: (f) => f.originalSize <= MAX_FILE_BYTES * 2 });
  } catch (e) {
    throw new Error(`that isn't a zip file I can open (${(e as Error).message})`);
  }
  // macOS adds a __MACOSX/ folder of resource forks next to the real one: never part of the project
  const names = Object.keys(entries).filter((n) => !n.endsWith("/") && !/^__MACOSX\//.test(n));
  // a zip of "my-app/…" becomes the repo's root
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const root = tops.size === 1 && names.every((n) => n.includes("/")) ? [...tops][0] : null;
  const files: { path: string; size: number }[] = [];
  const skipped: { path: string; why: string }[] = [];
  const env: string[] = [];
  let total = 0;
  for (const n of names) {
    const path = root ? n.slice(root.length + 1) : n;
    if (!path || path.includes("..") || path.startsWith("/") || /[\x00-\x1f]/.test(path)) {
      skipped.push({ path: n, why: "unsafe path" });
      continue;
    }
    const size = entries[n].length;
    const dir = `/${path}`.match(SKIP_DIR);
    if (dir) {
      // report each left-out folder once (e.g. node_modules, frontend/.next)
      const folder = `/${path}`.slice(1, (dir.index ?? 0) + dir[0].length - 1);
      if (!skipped.some((x) => x.path === folder)) skipped.push({ path: folder, why: "dependencies/build output" });
      continue;
    }
    if (SKIP_FILE.test(path)) continue;
    if (ENV_FILE.test(path) && !EXAMPLE_ENV.test(path)) {
      env.push(path);
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped.push({ path, why: `too big for git (${(size / 1048576).toFixed(1)} MB)` });
      continue;
    }
    if (files.length >= MAX_FILES || total + size > MAX_TOTAL) {
      skipped.push({ path, why: "over the import limit" });
      continue;
    }
    total += size;
    files.push({ path, size });
  }
  return { files, skipped, env, root };
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Create <owner>/<name> (private unless asked) and commit the zip's project to its default branch. */
export async function importZip(data: Buffer, opts: { name: string; private?: boolean; description?: string }): Promise<ZipImportResult> {
  if (!NAME_RE.test(opts.name)) throw new Error("repository name: letters, digits, . _ - only");
  const auth = await githubAuth();
  if (!auth) throw new Error("GitHub is not connected. Ask the user to click Connect GitHub on the Projects page.");
  const plan = inspectZip(data);
  if (!plan.files.length) throw new Error("the zip has no project files to import");
  const entries = unzipSync(new Uint8Array(data), { filter: (f) => f.originalSize <= MAX_FILE_BYTES * 2 });
  const read = (p: string) => Buffer.from(entries[plan.root ? `${plan.root}/${p}` : p]);

  // .env files: keep the values in the vault (named after their keys), never in git
  const envFiles: ZipImportResult["envFiles"] = [];
  for (const p of plan.env) {
    const masked = await vaultText(read(p).toString("utf8"));
    envFiles.push({ path: p, secrets: [...masked.matchAll(/\{\{secret:([A-Z0-9_]+)\}\}/g)].map((m) => m[1]) });
  }

  // the repo, with a first commit so the Git Data API has something to build on
  const created = await githubApiRaw("POST", "/user/repos", { name: opts.name, private: opts.private !== false, description: opts.description?.slice(0, 300), auto_init: true });
  if (created.status === 422 && /already exists/i.test(created.text)) throw new Error(`${auth.login}/${opts.name} already exists on GitHub: pick another name, or commit to it with repo_commit`);
  if (created.status >= 300) throw new Error(`GitHub couldn't create the repository (${created.status}): ${created.text.slice(0, 200)}`);
  const repo = JSON.parse(created.text) as { full_name: string; html_url: string; default_branch: string };
  const branch = repo.default_branch || "main";
  // GitHub needs a moment after auto_init before the branch is readable
  let head = "";
  for (let i = 0; i < 10 && !head; i++) {
    const ref = await githubApiRaw("GET", `/repos/${repo.full_name}/git/ref/heads/${branch}`);
    if (ref.status === 200) head = (JSON.parse(ref.text) as { object: { sha: string } }).object.sha;
    else await new Promise((r) => setTimeout(r, 1000));
  }
  if (!head) throw new Error(`created ${repo.full_name} but its first commit didn't appear`);

  // text files go inline in the tree; binary files become blobs first
  const tree: { path: string; mode: string; type: "blob"; content?: string; sha?: string }[] = [];
  const binary: string[] = [];
  for (const f of plan.files) {
    const buf = read(f.path);
    const text = buf.includes(0) ? null : buf.toString("utf8");
    if (text !== null && !text.includes("�") && buf.length < 1024 * 1024) tree.push({ path: f.path, mode: /\.(sh|py|rb|pl)$/.test(f.path) && text.startsWith("#!") ? "100755" : "100644", type: "blob", content: text });
    else binary.push(f.path);
  }
  for (let i = 0; i < binary.length; i += 6) {
    await Promise.all(
      binary.slice(i, i + 6).map(async (p) => {
        const b = await githubApiRaw("POST", `/repos/${repo.full_name}/git/blobs`, { content: read(p).toString("base64"), encoding: "base64" });
        if (b.status >= 300) throw new Error(`upload of ${p} failed (${b.status})`);
        tree.push({ path: p, mode: "100644", type: "blob", sha: (JSON.parse(b.text) as { sha: string }).sha });
      }),
    );
  }
  const t = await githubApiRaw("POST", `/repos/${repo.full_name}/git/trees`, { tree });
  if (t.status >= 300) throw new Error(`GitHub tree write failed (${t.status}): ${t.text.slice(0, 200)}`);
  const c = await githubApiRaw("POST", `/repos/${repo.full_name}/git/commits`, {
    message: `Import ${plan.root ?? opts.name} from a zip (${plan.files.length} files)`,
    tree: (JSON.parse(t.text) as { sha: string }).sha,
    parents: [head],
  });
  if (c.status >= 300) throw new Error(`GitHub commit failed (${c.status}): ${c.text.slice(0, 200)}`);
  const u = await githubApiRaw("PATCH", `/repos/${repo.full_name}/git/refs/heads/${branch}`, { sha: (JSON.parse(c.text) as { sha: string }).sha });
  if (u.status >= 300) throw new Error(`GitHub branch update failed (${u.status}): ${u.text.slice(0, 200)}`);

  return { repo: repo.full_name, url: repo.html_url, branch, files: plan.files.length, skipped: plan.skipped, envFiles, root: plan.root };
}
