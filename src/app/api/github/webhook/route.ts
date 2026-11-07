import { after } from "next/server";
import { listManifests, startDeploy } from "@/lib/agent";
import { getVms } from "@/lib/config";
import { verifyWebhook } from "@/lib/github";
import { mapLimit, withVm } from "@/lib/ssh";

export const maxDuration = 120;

interface Push {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  head_commit?: { message?: string; author?: { name?: string } } | null;
}

/**
 * POST /api/github/webhook: GitHub push events. Public (GitHub has no session), so every request must
 * carry a valid X-Hub-Signature-256 made with our webhook secret. Matching projects (same repo and
 * branch, auto-deploy on) are redeployed on every machine that runs them, after we've answered GitHub.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 5_000_000 || !verifyWebhook(raw, req.headers.get("x-hub-signature-256")))
    return Response.json({ error: "bad signature" }, { status: 401 });
  const event = req.headers.get("x-github-event");
  if (event === "ping") return Response.json({ ok: true, pong: true });
  if (event !== "push") return Response.json({ ok: true, ignored: event }, { status: 202 });

  let p: Push;
  try {
    p = JSON.parse(raw) as Push;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const repo = p.repository?.full_name?.toLowerCase();
  if (!repo || !p.ref?.startsWith("refs/heads/") || p.deleted) return Response.json({ ok: true, ignored: "not a branch push" }, { status: 202 });
  const branch = p.ref.slice("refs/heads/".length);
  const sha = (p.after ?? "").slice(0, 7);
  const msg = (p.head_commit?.message ?? "").split("\n")[0].slice(0, 60);

  after(async () => {
    const results = await mapLimit(getVms(), 8, async (vm) => {
      try {
        return await withVm(vm, async (conn) => {
          const hits = (await listManifests(conn)).filter((m) => m.github?.autoDeploy && m.github.repo.toLowerCase() === repo && (m.branch || "main") === branch);
          const started: string[] = [];
          for (const m of hits) started.push(`${m.name}:${await startDeploy(conn, m.name, `push ${sha}${msg ? ` ${msg}` : ""}`)}`);
          return { vm: vm.name, started };
        });
      } catch (e) {
        return { vm: vm.name, error: (e as Error).message };
      }
    });
    console.log(JSON.stringify({ audit: "github.push", repo, branch, sha, results }));
  });
  return Response.json({ ok: true, repo, branch, sha }, { status: 202 });
}
