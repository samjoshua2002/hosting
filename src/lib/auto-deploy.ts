// Auto-deploy safety net. GitHub's push webhook redeploys right away; when it is missed (the dashboard was
// asleep, the webhook was never added, a machine was down), Autopilot's pass catches up: every project with
// auto-deploy whose deployed commit isn't the branch's latest is redeployed, once per new commit (a commit
// whose build fails isn't retried every 15 minutes), and the repo's webhook is set up again.
import { startDeploy } from "./agent";
import { getVms } from "./config";
import { ensureWebhook, githubApiRaw, webhookUrl } from "./github";
import { withVm } from "./ssh";
import { storeGetJson, storePut } from "./store";
import type { VmStatus } from "./types";

const TRIED = "assistant/auto-deploy-tried.json";

export async function catchUpPushes(fleet: VmStatus[]): Promise<{ actions: string[]; problems: string[] }> {
  const actions: string[] = [];
  const problems: string[] = [];
  const heads = new Map<string, Promise<string | null>>();
  const head = (repo: string, branch: string) => {
    const k = `${repo}#${branch}`;
    if (!heads.has(k))
      heads.set(
        k,
        githubApiRaw("GET", `/repos/${repo}/commits/${encodeURIComponent(branch)}`)
          .then((r) => (r.status === 200 ? ((JSON.parse(r.text) as { sha?: string }).sha ?? null) : null))
          .catch(() => null),
      );
    return heads.get(k)!;
  };
  const tried = (await storeGetJson<Record<string, string>>(TRIED).catch(() => null)) ?? {};
  const rehook = new Set<string>();

  for (const s of fleet) {
    const a = s.agent;
    const vm = getVms().find((v) => v.name === s.name);
    if (!s.ok || !a || !vm) continue;
    for (const p of a.projects) {
      const m = p.manifest;
      // pinned to a saved version (a tag): it doesn't follow the branch on purpose
      if (!m.github?.autoDeploy || !m.branch || /^v\d+$/.test(m.branch)) continue;
      const deployed = p.commit?.sha;
      if (!deployed) continue;
      if (a.jobs.some((j) => j.state === "running" && j.meta.kind === "deploy" && j.meta.project === m.name)) continue;
      const latest = await head(m.github.repo, m.branch);
      if (!latest || latest.startsWith(deployed) || deployed.startsWith(latest)) continue;
      const key = `${s.name}/${m.name}`;
      if (tried[key] === latest) continue;
      tried[key] = latest;
      try {
        await withVm(vm, (c) => startDeploy(c, m.name, `push ${latest.slice(0, 7)} (caught up)`));
        actions.push(`redeployed ${m.name} on ${s.name}: GitHub has a newer commit (${latest.slice(0, 7)}) than the one running`);
        rehook.add(m.github.repo);
      } catch (e) {
        problems.push(`couldn't redeploy ${m.name} on ${s.name} for the new commit ${latest.slice(0, 7)}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
  await storePut(TRIED, JSON.stringify(tried)).catch(() => null);

  // a push was missed: make sure the repo's webhook exists so the next one deploys straight away
  const url = webhookUrl("");
  if (url.startsWith("https://")) for (const repo of rehook) await ensureWebhook(repo, url).catch(() => null);
  return { actions, problems };
}
