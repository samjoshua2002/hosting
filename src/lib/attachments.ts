// Files attached to Assistant sessions, kept on the storage machine under files/<session>/<id>__<name>.
import { storeConcat, storeGet, storeList, storePut } from "./store";

export const SESSION_RE = /^[a-z0-9-]{8,64}$/;
/** Vercel request bodies top out around 4.5 MB, so bigger files come in pieces of this size and are joined on the storage machine. */
export const CHUNK_BYTES = 2_500_000;
export const MAX_ATTACHMENT = 50 * 1024 * 1024;
export const UPLOAD_RE = /^[a-z0-9]{8,32}$/;

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
}

export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
}

export async function saveAttachment(session: string, name: string, type: string, data: Buffer): Promise<Attachment> {
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const file = safeName(name);
  await storePut(`files/${session}/${id}__${file}`, data);
  return { id, name: file, size: data.length, type: type || "application/octet-stream" };
}

/** One piece of a big upload (index from 0). */
export async function saveChunk(session: string, upload: string, index: number, data: Buffer): Promise<void> {
  if (!SESSION_RE.test(session) || !UPLOAD_RE.test(upload) || !Number.isInteger(index) || index < 0 || index > 999) throw new Error("bad upload piece");
  if (data.length > CHUNK_BYTES + 1024) throw new Error("upload piece too large");
  await storePut(`files/${session}/up-${upload}/${String(index).padStart(4, "0")}`, data);
}

/** All pieces are there: join them into the attachment (checked against the size the browser announced). */
export async function finishUpload(session: string, upload: string, parts: number, size: number, name: string, type: string): Promise<Attachment> {
  if (!SESSION_RE.test(session) || !UPLOAD_RE.test(upload) || !Number.isInteger(parts) || parts < 1 || parts > 1000) throw new Error("bad upload");
  if (!Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT) throw new Error(`attachments are limited to ${MAX_ATTACHMENT / 1048576} MB`);
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const file = safeName(name);
  const pieces = Array.from({ length: parts }, (_, i) => `files/${session}/up-${upload}/${String(i).padStart(4, "0")}`);
  const got = await storeConcat(pieces, `files/${session}/${id}__${file}`, MAX_ATTACHMENT);
  if (got !== size) throw new Error(`upload incomplete (${got} of ${size} bytes): try again`);
  return { id, name: file, size: got, type: type || "application/octet-stream" };
}

export async function loadAttachment(session: string, id: string): Promise<{ name: string; data: Buffer } | null> {
  if (!SESSION_RE.test(session) || !/^a[a-z0-9]{4,20}$/.test(id)) return null;
  const hit = (await storeList(`files/${session}`)).find((f) => f.name.startsWith(`${id}__`));
  if (!hit) return null;
  const data = await storeGet(`files/${session}/${hit.name}`, MAX_ATTACHMENT);
  return data ? { name: hit.name.slice(id.length + 2), data } : null;
}

/** Text if the file looks like text (no NUL bytes, valid UTF-8), else null. */
export function asText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  const s = data.toString("utf8");
  return s.includes("�") ? null : s;
}
