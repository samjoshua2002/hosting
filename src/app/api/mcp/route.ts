import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { addServer, listServers, MCP_SUGGESTIONS, refreshServer, removeServer, setEnabled } from "@/lib/mcp";

export const maxDuration = 60;

/** GET /api/mcp: connected MCP servers (never their tokens) and suggestions. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({ servers: await listServers(), suggestions: MCP_SUGGESTIONS });
});

/** POST /api/mcp { add: {name, url, token?} } | { remove } | { refresh } | { enable, on } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ add?: { name?: unknown; url?: unknown; token?: unknown }; remove?: unknown; refresh?: unknown; enable?: unknown; on?: unknown }>(req, 10_000);
  try {
    if (b.add) await addServer(String(b.add.name ?? "").toLowerCase(), String(b.add.url ?? ""), typeof b.add.token === "string" && b.add.token.trim() ? b.add.token.trim() : undefined);
    else if (typeof b.remove === "string") await removeServer(b.remove);
    else if (typeof b.refresh === "string") await refreshServer(b.refresh);
    else if (typeof b.enable === "string") await setEnabled(b.enable, b.on !== false);
    else throw new HttpError(400, "add, remove, refresh or enable");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
  return Response.json({ servers: await listServers(), suggestions: MCP_SUGGESTIONS });
});
