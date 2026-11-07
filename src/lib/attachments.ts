// Files attached to Assistant sessions, kept on the storage machine under files/<session>/<id>__<name>.
import { storeGet, storeList, storePut } from "./store";

export const SESSION_RE = /^[a-z0-9-]{8,64}$/;
export const MAX_ATTACHMENT = 3 * 1024 * 1024; // Vercel request bodies top out around 4.5 MB

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

export async function loadAttachment(session: string, id: string): Promise<{ name: string; data: Buffer } | null> {
  if (!SESSION_RE.test(session) || !/^a[a-z0-9]{4,20}$/.test(id)) return null;
  const hit = (await storeList(`files/${session}`)).find((f) => f.name.startsWith(`${id}__`));
  if (!hit) return null;
  const data = await storeGet(`files/${session}/${hit.name}`);
  return data ? { name: hit.name.slice(id.length + 2), data } : null;
}

/** Text if the file looks like text (no NUL bytes, valid UTF-8), else null. */
export function asText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  const s = data.toString("utf8");
  return s.includes("�") ? null : s;
}
