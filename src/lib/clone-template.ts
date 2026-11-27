// The clone-website skill of JCodesMore/ai-website-cloner-template (MIT), read live from GitHub so the
// Assistant follows its current version, with a note mapping its generic steps to the Assistant's tools.
const REPO = "JCodesMore/ai-website-cloner-template";
const FILES = [
  ".agents/skills/clone-website/SKILL.md",
  ".agents/skills/clone-website/references/inspection-guide.md",
  ".agents/skills/clone-website/references/framer-and-motion.md",
];
const TTL = 6 * 3600_000;
let cache: { at: number; text: string } | null = null;

const ADAPTER = `How its steps map to your tools here (you have no local browser or file system; you work through tools):
- "open/inspect in a browser", screenshots, computed styles, scrolling, states: capture_site (one call per page, up to 4 more pages via pages). For a specific state (menu open, tab, hover) use screenshot with the URL, or note it as a gap.
- "compare source and local pages": compare_sites {original, clone} after each deploy; view_image for images on a machine.
- "extract assets / fonts / SVGs": the capture's asset list and SVG attachments; import_assets into public/sites/<site>/ (dir "public/sites/<site>"), SVG markup into src/components/sites/<site>/icons.tsx.
- "the current app / project": a repo made with create_repo_from_template (this template), edited with repo_read/repo_commit, deployed with deploy_project using its Dockerfile.
- "run the project check / production check": the deploy's Docker build (npm run build) plus job_log; fix every build error.
- "delegate builders": you build sections yourself, one page at a time, keeping update_plan current.
- docs/research/<site>/: put the page brief there with repo_commit (short markdown), not in chat.`;

export async function cloneTemplateSkill(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL) return cache.text;
  const parts = await Promise.all(
    FILES.map(async (f) => {
      const r = await fetch(`https://raw.githubusercontent.com/${REPO}/HEAD/${f}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      return r?.ok ? `--- ${f} ---\n${(await r.text()).slice(0, 9000)}` : "";
    }),
  );
  const body = parts.filter(Boolean).join("\n\n");
  if (!body) return cache?.text ?? "";
  const text = `Reference playbook: the clone-website skill of ${REPO} (the template your clone repos start from). Follow its method; use your tools as mapped below.\n${ADAPTER}\n\n${body}`;
  cache = { at: Date.now(), text };
  return text;
}
