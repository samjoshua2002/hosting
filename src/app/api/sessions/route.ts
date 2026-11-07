import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { storeDelete, storeGetJson, storePut } from "@/lib/store";

export const maxDuration = 60;

const ID = /^[a-z0-9-]{8,64}$/;
const INDEX = "sessions/index.json";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
}

/** GET /api/sessions → list · GET /api/sessions?id=… → one session. Stored on the storage machine (box5). */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ sessions: (await storeGetJson<SessionMeta[]>(INDEX)) ?? [] });
  if (!ID.test(id)) throw new HttpError(400, "bad id");
  const s = await storeGetJson<Record<string, unknown>>(`sessions/${id}.json`);
  if (!s) throw new HttpError(404, "session not found");
  return Response.json(s);
});

/** POST /api/sessions { id, title, items, transcript, attachments } saves a session. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ id?: unknown; title?: unknown; items?: unknown; transcript?: unknown; attachments?: unknown }>(req, 3_000_000);
  if (typeof b.id !== "string" || !ID.test(b.id)) throw new HttpError(400, "bad id");
  const title = (typeof b.title === "string" ? b.title : "Untitled").slice(0, 120);
  const updatedAt = Date.now();
  await storePut(`sessions/${b.id}.json`, JSON.stringify({ id: b.id, title, updatedAt, items: b.items ?? [], transcript: b.transcript ?? [], attachments: b.attachments ?? [] }));
  const index = ((await storeGetJson<SessionMeta[]>(INDEX)) ?? []).filter((s) => s.id !== b.id);
  index.unshift({ id: b.id, title, updatedAt });
  await storePut(INDEX, JSON.stringify(index.slice(0, 300)));
  return Response.json({ ok: true, updatedAt });
});

/** DELETE /api/sessions?id=… removes a session and its attachments. */
export const DELETE = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!ID.test(id)) throw new HttpError(400, "bad id");
  await storeDelete(`sessions/${id}.json`);
  await storeDelete(`files/${id}`);
  const index = ((await storeGetJson<SessionMeta[]>(INDEX)) ?? []).filter((s) => s.id !== id);
  await storePut(INDEX, JSON.stringify(index));
  return Response.json({ ok: true });
});
