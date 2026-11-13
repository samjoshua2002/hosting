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
 * { id, title, items, transcript, attachments } saves one (runs save themselves);
 * { id, voice: [{role, text}], title? } adds a voice conversation to it (shown in the chat, and in the transcript
 * so the Assistant remembers it).
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ id?: unknown; title?: unknown; items?: unknown; transcript?: unknown; attachments?: unknown; rename?: unknown; pin?: unknown; voice?: unknown }>(req, 3_000_000);
  if (typeof b.id !== "string" || !SESSION_ID.test(b.id)) throw new HttpError(400, "bad id");
  if (Array.isArray(b.voice)) {
    const turns = b.voice
      .filter((t): t is { role: string; text: string } => !!t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string" && (t as { text: string }).text.trim() !== "")
      .slice(0, 200)
      .map((t) => ({ role: t.role === "assistant" ? ("assistant" as const) : ("user" as const), text: t.text.trim().slice(0, 4000) }));
    if (!turns.length) return Response.json({ ok: true, added: 0 });
    const cur = await storeGetJson<{ title?: string; items?: unknown[]; transcript?: unknown[]; attachments?: unknown[]; running?: boolean; updatedAt?: number; named?: boolean; titled?: boolean; pinned?: boolean; source?: string }>(sessionPath(b.id));
    if (cur?.running && Date.now() - (cur.updatedAt ?? 0) < 6 * 60_000) throw new HttpError(409, "This session is working right now; try again when it finishes.");
    const first = turns.find((t) => t.role === "user")?.text ?? "Voice conversation";
    const title = cur?.title && cur.title !== "New session" ? cur.title : typeof b.title === "string" && b.title.trim() && b.title !== "New session" ? b.title.slice(0, 120) : first.split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
    const updatedAt = Date.now();
    const doc = {
      ...(cur ?? {}),
      id: b.id,
      title,
      updatedAt,
      items: [...(cur?.items ?? []), ...turns.map((t) => (t.role === "user" ? { kind: "user", text: t.text, voice: true } : { kind: "text", text: t.text, voice: true }))],
      // the transcript keeps its system message first; voice turns follow as plain conversation
      transcript: [...(cur?.transcript ?? []), ...turns.map((t) => ({ role: t.role, content: t.role === "user" ? `(said in voice mode) ${t.text}` : t.text }))],
      attachments: cur?.attachments ?? [],
    };
    await storePut(sessionPath(b.id), JSON.stringify(doc));
    await updateIndex({ id: b.id, title, updatedAt });
    return Response.json({ ok: true, added: turns.length, title });
  }
  if (typeof b.rename === "string" || typeof b.pin === "boolean") {
    const meta = await editSession(b.id, { title: typeof b.rename === "string" ? b.rename : undefined, pinned: typeof b.pin === "boolean" ? b.pin : undefined }).catch((e: Error) => {
      throw new HttpError(404, e.message);
    });
    return Response.json(meta);
  }
  const title = (typeof b.title === "string" ? b.title : "Untitled").slice(0, 120);
  const updatedAt = Date.now();
  const cur = await storeGetJson<{ running?: boolean; updatedAt?: number }>(sessionPath(b.id));
  if (cur?.running && Date.now() - (cur.updatedAt ?? 0) < 6 * 60_000) throw new HttpError(409, "This session is working right now; its progress is saved by the run itself.");
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
