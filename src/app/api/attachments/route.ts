import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { CHUNK_BYTES, finishUpload, loadAttachment, saveAttachment, saveChunk, SESSION_RE } from "@/lib/attachments";
import { audit } from "@/lib/security";

export const maxDuration = 120;

/**
 * POST /api/attachments
 *   { session, name, type, data (base64) }                         small file in one go (up to one piece)
 *   { session, upload, index, data (base64) }                      one piece of a big file
 *   { session, upload, finish: true, parts, size, name, type }     join the pieces → { id, name, size, type }
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ session?: unknown; name?: unknown; type?: unknown; data?: unknown; upload?: unknown; index?: unknown; finish?: unknown; parts?: unknown; size?: unknown }>(req, 4_400_000);
  if (typeof b.session !== "string" || !SESSION_RE.test(b.session)) throw new HttpError(400, "bad session");
  try {
    if (typeof b.upload === "string") {
      if (b.finish === true) {
        const att = await finishUpload(b.session, b.upload, Number(b.parts), Number(b.size), String(b.name ?? "file"), String(b.type ?? ""));
        audit(req, "attachment.upload", { session: b.session, name: att.name, size: att.size });
        return Response.json(att);
      }
      if (typeof b.data !== "string") throw new HttpError(400, "missing data");
      await saveChunk(b.session, b.upload, Number(b.index), Buffer.from(b.data, "base64"));
      return Response.json({ ok: true });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
  if (typeof b.data !== "string") throw new HttpError(400, "missing data");
  const data = Buffer.from(b.data, "base64");
  if (data.length > CHUNK_BYTES + 1024) throw new HttpError(413, "send files over 2.5 MB in pieces");
  const att = await saveAttachment(b.session, String(b.name ?? "file"), String(b.type ?? ""), data);
  audit(req, "attachment.upload", { session: b.session, name: att.name, size: att.size });
  return Response.json(att);
});

/** GET /api/attachments?session=…&id=… downloads it. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const p = req.nextUrl.searchParams;
  const file = await loadAttachment(p.get("session") ?? "", p.get("id") ?? "");
  if (!file) throw new HttpError(404, "not found");
  return new Response(new Uint8Array(file.data), {
    headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${file.name}"` },
  });
});
