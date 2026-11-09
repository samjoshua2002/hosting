import { connection, type NextRequest } from "next/server";
import { listManifests, PROJECT_NAME_RE } from "@/lib/agent";
import { verifySession } from "@/lib/auth";
import { getVms } from "@/lib/config";
import { refreshMachines } from "@/lib/machines";
import { mapLimit, run, withVm } from "@/lib/ssh";

export const maxDuration = 30;

// name → links of its running copies, kept briefly so a click doesn't wait on every machine
const cache = new Map<string, { at: number; links: { url: string; up: boolean }[] }>();

async function linksFor(name: string): Promise<{ url: string; up: boolean }[]> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.links;
  await refreshMachines();
  const found = await mapLimit(getVms(), 12, async (vm) => {
    try {
      return await withVm(vm, async (c) => {
        if (!(await listManifests(c)).some((m) => m.name === name)) return [];
        const r = await run(c, `cat "$HOME/.hosting/projects/${name}.url" 2>/dev/null; echo; systemctl --user is-active hosting-${name}.service 2>/dev/null`, { timeoutMs: 10_000 });
        const [url, state] = r.stdout.split("\n").map((x) => x.trim());
        return url?.startsWith("https://") ? [{ url, up: state === "active" }] : [];
      });
    } catch {
      return []; // resting or unreachable: try the others
    }
  });
  const links = found.flat().sort((a, b) => Number(b.up) - Number(a.up));
  cache.set(name, { at: Date.now(), links });
  return links;
}

/**
 * GET /go/<project>: a short, readable link (hosting…/go/ollama) that forwards to the project's current link,
 * preferring a copy that's running. Private links (with a secret token) only forward for a signed-in user.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  await connection();
  const { name } = await ctx.params;
  if (!PROJECT_NAME_RE.test(name)) return new Response("Not found", { status: 404 });
  const links = await linksFor(name);
  if (!links.length) return new Response(`${name} has no link right now (it may be starting or its machine is resting). Try again in a minute.`, { status: 404 });
  const target = links[0].url;
  if (target.includes("_token=") && !(await verifySession(req.cookies))) {
    const login = req.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return Response.redirect(login, 307);
  }
  return new Response(null, { status: 307, headers: { Location: target, "Cache-Control": "no-store" } });
}
