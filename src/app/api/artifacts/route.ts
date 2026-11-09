import type { NextRequest } from "next/server";
import type { Item } from "@/lib/assistant-items";
import { handle, requireAuth } from "@/lib/api";
import { listSessions, sessionPath } from "@/lib/sessions";
import { mapLimit } from "@/lib/ssh";
import { storeGetJson } from "@/lib/store";

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
