import type { NextRequest } from "next/server";
import type { Item } from "@/lib/assistant-items";
import { handle, requireAuth } from "@/lib/api";
import { listSessions, sessionPath } from "@/lib/sessions";
import { mapLimit } from "@/lib/ssh";
import { storeGetJson, storePut } from "@/lib/store";

export const maxDuration = 60;

interface ArtifactEntry {
  session: string;
  sessionTitle: string;
  id: string;
  title: string;
  type: string;
  language?: string;
  version: number;
  updatedAt: number;
  /** first part of the content, for the gallery preview */
  preview: string;
}

let cache: { at: number; list: ArtifactEntry[] } | null = null;

/** GET /api/artifacts: the latest version of every artifact in every conversation, newest first. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (cache && Date.now() - cache.at < 60_000 && !req.nextUrl.searchParams.has("fresh")) return Response.json({ artifacts: cache.list });
  const sessions = (await listSessions()).slice(0, 80);
  const per = await mapLimit(sessions, 8, async (s) => {
    const doc = await storeGetJson<{ items?: Item[] }>(sessionPath(s.id)).catch(() => null);
    const latest = new Map<string, Extract<Item, { kind: "artifact" }>>();
    for (const i of doc?.items ?? []) if (i.kind === "artifact") latest.set(i.id, i);
    return [...latest.values()].map((a) => ({
      session: s.id,
      sessionTitle: s.title,
      id: a.id,
      title: a.title,
      type: a.type,
      language: a.language,
      version: a.version,
      updatedAt: s.updatedAt,
      preview: a.content.slice(0, a.type === "html" || a.type === "svg" ? 60_000 : 1200),
    }));
  });
  const list = per.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  cache = { at: Date.now(), list };
  return Response.json({ artifacts: list });
});

/**
 * DELETE /api/artifacts?session=…&id=…: remove one artifact (every version) from its conversation. The rest of
 * the conversation stays as it was.
 */
export const DELETE = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const session = req.nextUrl.searchParams.get("session") ?? "";
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[\w-]{1,80}$/.test(session) || !id) return Response.json({ error: "session and id are required" }, { status: 400 });
  const doc = await storeGetJson<{ items?: Item[] } & Record<string, unknown>>(sessionPath(session));
  if (!doc) return Response.json({ error: "conversation not found" }, { status: 404 });
  const items = doc.items ?? [];
  const kept = items.filter((i) => !(i.kind === "artifact" && i.id === id));
  if (kept.length === items.length) return Response.json({ error: "artifact not found" }, { status: 404 });
  await storePut(sessionPath(session), JSON.stringify({ ...doc, items: kept }));
  cache = null;
  return Response.json({ ok: true, removed: items.length - kept.length });
});
