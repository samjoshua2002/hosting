import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { listSessions, SESSION_ID, sessionPath, updateIndex } from "@/lib/sessions";
import { storeDelete, storeGetJson, storePut } from "@/lib/store";

export const maxDuration = 60;

/** GET /api/sessions → list · GET /api/sessions?id=… → one session. Stored on the storage machine (box5). */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ sessions: await listSessions() });
  if (!SESSION_ID.test(id)) throw new HttpError(400, "bad id");
  const s = await storeGetJson<Record<string, unknown>>(sessionPath(id));
  if (!s) throw new HttpError(404, "session not found");
  if (s.running && typeof s.updatedAt === "number" && Date.now() - s.updatedAt > 6 * 60_000) s.running = false;
  return Response.json(s);
});

/** POST /api/sessions { id, title, items, transcript, attachments } saves a session (runs save themselves). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ id?: unknown; title?: unknown; items?: unknown; transcript?: unknown; attachments?: unknown }>(req, 3_000_000);
  if (typeof b.id !== "string" || !SESSION_ID.test(b.id)) throw new HttpError(400, "bad id");
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
