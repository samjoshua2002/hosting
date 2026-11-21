import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { addServer, exportUniversalConfig, importUniversalConfig, listServers, MCP_SUGGESTIONS, refreshServer, removeServer, setEnabled } from "@/lib/mcp";

export const maxDuration = 60;

/** GET /api/mcp: connected MCP servers (never their tokens), suggestions, and universal config. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({
    servers: await listServers(),
    suggestions: MCP_SUGGESTIONS,
    config: await exportUniversalConfig(),
  });
});

/** POST /api/mcp { config } | { add: {name, url, token?} } | { remove } | { refresh } | { enable, on } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{
    config?: unknown;
    add?: { name?: unknown; url?: unknown; token?: unknown; command?: unknown; args?: unknown; env?: unknown };
    remove?: unknown;
    refresh?: unknown;
    enable?: unknown;
    on?: unknown;
  }>(req, 100_000);
  try {
    if (b.config) await importUniversalConfig(b.config);
    else if (b.add) {
      if (typeof b.add.command === "string" && b.add.command.trim()) {
        await importUniversalConfig({
          mcpServers: {
            [String(b.add.name ?? "").toLowerCase()]: {
              command: b.add.command,
              args: Array.isArray(b.add.args) ? b.add.args : undefined,
              env: b.add.env && typeof b.add.env === "object" ? b.add.env : undefined,
            },
          },
        });
      } else {
        await addServer(String(b.add.name ?? "").toLowerCase(), String(b.add.url ?? ""), typeof b.add.token === "string" && b.add.token.trim() ? b.add.token.trim() : undefined);
      }
    } else if (typeof b.remove === "string") await removeServer(b.remove);
    else if (typeof b.refresh === "string") await refreshServer(b.refresh);
    else if (typeof b.enable === "string") await setEnabled(b.enable, b.on !== false);
    else throw new HttpError(400, "config, add, remove, refresh or enable");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
  return Response.json({
    servers: await listServers(),
    suggestions: MCP_SUGGESTIONS,
    config: await exportUniversalConfig(),
  });
});
