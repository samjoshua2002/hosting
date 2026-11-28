// One app, one card: the parts of an app (website, API, worker, its own database) are grouped like a Vercel
// project instead of showing as separate projects. Parts belong together when they deploy from the same
// GitHub repo, or when one uses another that nothing else uses (a database shared by two apps stays on its own).
import type { ProjectManifest } from "./types";

/** owner/name for a GitHub link or a github.com URL; otherwise the clone URL without credentials. */
export function repoKey(m: Pick<ProjectManifest, "repo" | "github">): string | null {
  if (m.github?.repo) return m.github.repo.toLowerCase();
  if (!m.repo) return null;
  const clean = m.repo.replace(/^https?:\/\/([^@/]*@)?/, "").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  const gh = /^github\.com\/([^/]+\/[^/]+)$/.exec(clean);
  return gh ? gh[1] : clean;
}

export interface Group<T> {
  /** stable id: the repo, or the main part's name */
  key: string;
  /** what the card is called */
  title: string;
  /** the part the card leads with (the website, else the first app) */
  main: T;
  /** every part, main first */
  parts: T[];
}

/**
 * Group items (each with a manifest) into apps. rank orders parts inside a group (lower = shown first),
 * e.g. website 0, service 1, worker 2, database 3.
 */
export function groupProjects<T extends { name: string; m: ProjectManifest }>(items: T[], rank: (x: T) => number): Group<T>[] {
  const parent = new Map<string, string>(items.map((x) => [x.name, x.name]));
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const join = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  // same repo → same app
  const byRepo = new Map<string, string>();
  for (const x of items) {
    const k = repoKey(x.m);
    if (!k) continue;
    const first = byRepo.get(k);
    if (first) join(first, x.name);
    else byRepo.set(k, x.name);
  }
  // a part only one app uses (its own API or database) joins that app
  const users = new Map<string, string[]>();
  for (const x of items) for (const u of x.m.uses ?? []) users.set(u.name, [...(users.get(u.name) ?? []), x.name]);
  for (const [used, by] of users) if (new Set(by).size === 1) join(by[0], used);

  const groups = new Map<string, T[]>();
  for (const x of items) groups.set(find(x.name), [...(groups.get(find(x.name)) ?? []), x]);

  return [...groups.values()].map((parts) => {
    parts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const main = parts[0];
    const repo = repoKey(main.m);
    const title = parts.length > 1 && main.m.github?.repo && parts.every((p) => repoKey(p.m) === repo) ? main.m.github.repo.split("/")[1] : main.name;
    return { key: parts.length > 1 ? `g:${repo ?? main.name}` : main.name, title, main, parts };
  });
}
