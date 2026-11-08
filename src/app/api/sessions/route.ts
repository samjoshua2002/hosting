import { after, type NextRequest } from "next/server";
import { aiConfigured } from "@/lib/ai";
import { backfillTitles } from "@/lib/session-title";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { editSession, listSessions, SESSION_ID, sessionPath, updateIndex } from "@/lib/sessions";
import { storeDelete, storeGetJson, storePut } from "@/lib/store";

export const maxDuration = 60;

/** GET /api/sessions → list · GET /api/sessions?id=… → one session. Stored on the storage machine (box5). */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    const sessions = await listSessions();
    if (aiConfigured() && sessions.some((x) => !x.named && !x.running && (!x.titled || /\n|\.\s/.test(x.title) || x.title.split(" ").length > 8)))
      after(() => backfillTitles().catch(() => {}));
    return Response.json({ sessions });
  }
  if (!SESSION_ID.test(id)) throw new HttpError(400, "bad id");
  const s = await storeGetJson<Record<string, unknown>>(sessionPath(id));
  if (!s) throw new HttpError(404, "session not found");
  if (s.running && typeof s.updatedAt === "number" && Date.now() - s.updatedAt > 6 * 60_000) s.running = false;
  return Response.json(s);
});

/**
 * POST /api/sessions { id, rename?: string, pin?: boolean } renames or pins a session;
 * { id, title, items, transcript, attachments } saves one (runs save themselves).
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ id?: unknown; title?: unknown; items?: unknown; transcript?: unknown; attachments?: unknown; rename?: unknown; pin?: unknown }>(req, 3_000_000);
  if (typeof b.id !== "string" || !SESSION_ID.test(b.id)) throw new HttpError(400, "bad id");
  if (typeof b.rename === "string" || typeof b.pin === "boolean") {
    const meta = await editSession(b.id, { title: typeof b.rename === "string" ? b.rename : undefined, pinned: typeof b.pin === "boolean" ? b.pin : undefined }).catch((e: Error) => {
      throw new HttpError(404, e.message);
    });
    return Response.json(meta);
  }
  const title = (typeof b.title === "string" ? b.title : "Untitled").slice(0, 120);
  const updatedAt = Date.now();
  await storePut(sessionPath(b.id), JSON.stringify({ id: b.id, title, updatedAt, items: b.items ?? [], transcript: b.transcript ?? [], attachments: b.attachments ?? [] }));
  await updateIndex({ id: b.id, title, updatedAt });
  return Response.json({ ok: true, updatedAt });
});

/** DELETE /api/sessions?id=… removes a session and its attachments. */
export const DELETE = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!SESSION_ID.test(id)) throw new HttpError(400, "bad id");
  await storeDelete(sessionPath(id));
  await storeDelete(`files/${id}`);
  await updateIndex({ id, remove: true });
  return Response.json({ ok: true });
});
