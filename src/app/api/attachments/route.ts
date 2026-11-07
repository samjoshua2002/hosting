import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { loadAttachment, MAX_ATTACHMENT, saveAttachment, SESSION_RE } from "@/lib/attachments";
import { audit } from "@/lib/security";

export const maxDuration = 60;

/** POST /api/attachments { session, name, type, data (base64) } → { id, name, size, type } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ session?: unknown; name?: unknown; type?: unknown; data?: unknown }>(req, 4_400_000);
  if (typeof b.session !== "string" || !SESSION_RE.test(b.session)) throw new HttpError(400, "bad session");
  if (typeof b.data !== "string") throw new HttpError(400, "missing data");
  const data = Buffer.from(b.data, "base64");
  if (data.length > MAX_ATTACHMENT) throw new HttpError(413, "attachments are limited to 3 MB");
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
