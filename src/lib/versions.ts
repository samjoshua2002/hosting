// Project versions: named milestones of a GitHub project ("v1 dark theme", "v2 light theme").
// A version is a git tag (v1, v2, …) on the repo plus a name and note kept by the dashboard. Corrections are
// ordinary commits; only "save version" makes a version, when the user is happy with a complete change.
// Making a version live redeploys the project from its tag (pushes to the branch then don't move it, because the
// project now follows the tag); "Latest" puts it back on the branch. "Continue from" makes an old version the
// current code with a new commit, so later versions stay intact.
import { ensureAgent, listManifests, saveProject, startDeploy, type ProjectInput } from "./agent";
import { getVms, type VmConfig } from "./config";
import { githubApiRaw, getRepo, REPO_RE } from "./github";
import { mapLimit, withVm } from "./ssh";
import { storeGetJson, storePut } from "./store";
import type { ProjectManifest } from "./types";

export interface Version {
  n: number;
  tag: string;
  name: string;
  note: string;
  sha: string;
  branch: string;
  at: number;
}
interface VersionsDoc {
  repo: string;
  versions: Version[];
}

const path = (repo: string) => `versions/${repo.toLowerCase().replace("/", "__")}.json`;

async function gh<T>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await githubApiRaw(method, p, body);
  if (r.status >= 300) throw new Error(`GitHub ${method} ${p} failed (${r.status}): ${r.text.slice(0, 200)}`);
  return (r.text ? JSON.parse(r.text) : {}) as T;
}

export async function listVersions(repo: string): Promise<Version[]> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  return (await storeGetJson<VersionsDoc>(path(repo)))?.versions ?? [];
}

/** Tag the branch's current commit as the next version (v1, v2, …) with a name and note. */
export async function saveVersion(repo: string, opts: { name: string; note?: string; branch?: string }): Promise<Version> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  const name = opts.name.trim().slice(0, 80);
  if (!name) throw new Error("give the version a short name, e.g. \"Light theme\"");
  const branch = opts.branch || (await getRepo(repo)).defaultBranch;
  const head = await gh<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const doc = (await storeGetJson<VersionsDoc>(path(repo))) ?? { repo, versions: [] };
  const last = doc.versions.at(-1);
  if (last && last.sha === head.object.sha) throw new Error(`nothing changed since ${last.tag} (${last.name}): it already is this code`);
  let n = (last?.n ?? 0) + 1;
  // a tag with that number may already exist in the repo (made by hand): take the next free one
  for (;;) {
    const r = await githubApiRaw("POST", `/repos/${repo}/git/refs`, { ref: `refs/tags/v${n}`, sha: head.object.sha });
    if (r.status < 300) break;
    if (r.status === 422 && /already exists/i.test(r.text) && n < 999) {
      n++;
      continue;
    }
    throw new Error(`GitHub couldn't create tag v${n} (${r.status}): ${r.text.slice(0, 200)}`);
  }
  const v: Version = { n, tag: `v${n}`, name, note: (opts.note ?? "").trim().slice(0, 500), sha: head.object.sha, branch, at: Date.now() };
  doc.versions.push(v);
  await storePut(path(repo), JSON.stringify(doc));
  return v;
}

/** Every machine running the project, with its manifest. */
async function placesOf(project: string): Promise<{ vm: VmConfig; m: ProjectManifest }[]> {
  const found = await mapLimit(getVms(), 8, async (vm) => {
    try {
      const ms = await withVm(vm, (c) => listManifests(c));
      const m = ms.find((x) => x.name === project);
      return m ? [{ vm, m }] : [];
    } catch {
      return [];
    }
  });
  return found.flat();
}

const inputFrom = (m: ProjectManifest, branch: string): ProjectInput => ({
  name: m.name,
  repo: m.repo,
  branch,
  install: m.install,
  build: m.build,
  start: m.start,
  port: m.port,
  publish: m.publish,
  access: m.access ?? "public",
  category: m.category ?? "app",
  env: null, // keep the env already on the machine
});

/**
 * Make a version live ("v2"), or "latest" to follow the repo's branch again (auto-deploy resumes).
 * Returns the deploy jobs started.
 */
export async function switchVersion(project: string, version: string): Promise<{ repo: string; live: string; jobs: { vm: string; id: string }[] }> {
  const places = await placesOf(project);
  if (!places.length) throw new Error(`no project named ${project} on any machine`);
  const repo = places[0].m.github?.repo;
  if (!repo) throw new Error(`${project} isn't linked to a GitHub repo, so it has no versions`);
  const versions = await listVersions(repo);
  let ref: string;
  if (version === "latest") ref = versions.at(-1)?.branch || (await getRepo(repo)).defaultBranch;
  else {
    const v = versions.find((x) => x.tag === version || String(x.n) === version.replace(/^v/i, "") || x.name.toLowerCase() === version.toLowerCase());
    if (!v) throw new Error(`no version ${version} for ${repo} (have: ${versions.map((x) => `${x.tag} ${x.name}`).join(", ") || "none"})`);
    ref = v.tag;
  }
  const jobs = await mapLimit(places, 4, async ({ vm, m }) =>
    withVm(vm, async (c) => {
      await ensureAgent(c);
      await saveProject(c, inputFrom(m, ref));
      return { vm: vm.name, id: await startDeploy(c, project, ref === m.branch ? "redeploy" : `version ${ref}`) };
    }),
  );
  return { repo, live: ref, jobs };
}

/** Which version each project of the repo is showing: a tag, or the branch (latest). */
export async function liveRef(project: string): Promise<string | null> {
  const places = await placesOf(project);
  return places[0]?.m.branch ?? null;
}

/**
 * Continue working from an old version: a new commit on the branch whose files are exactly that version's.
 * Later versions stay as they are (their tags don't move); save a new version when the next change is done.
 */
export async function continueFrom(repo: string, version: string): Promise<{ sha: string; url: string; branch: string }> {
  const versions = await listVersions(repo);
  const v = versions.find((x) => x.tag === version || String(x.n) === version.replace(/^v/i, ""));
  if (!v) throw new Error(`no version ${version} for ${repo}`);
  const branch = v.branch || (await getRepo(repo)).defaultBranch;
  const old = await gh<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${v.sha}`);
  const head = await gh<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const c = await gh<{ sha: string }>("POST", `/repos/${repo}/git/commits`, { message: `Continue from ${v.tag} (${v.name})`, tree: old.tree.sha, parents: [head.object.sha] });
  await gh("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: c.sha, force: false });
  return { sha: c.sha, url: `https://github.com/${repo}/commit/${c.sha}`, branch };
}
