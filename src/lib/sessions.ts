// Assistant sessions on the storage machine: one JSON document per session plus a small index.
import type { Att, Item } from "./assistant-items";
import { storeGetJson, storePut, storePutAndTakeFlag } from "./store";

export const SESSION_ID = /^[a-z0-9-]{8,64}$/;
const INDEX = "sessions/index.json";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** a run is going on right now (saved by the server while it works) */
  running?: boolean;
}

export interface SessionDoc extends SessionMeta {
  items: Item[];
  transcript: unknown[];
  attachments: Att[];
}

export const sessionPath = (id: string) => `sessions/${id}.json`;
const stopPath = (id: string) => `sessions/${id}.stop`;

export async function listSessions(): Promise<SessionMeta[]> {
  const index = (await storeGetJson<SessionMeta[]>(INDEX)) ?? [];
  // a run that stopped saving long ago crashed or timed out
  return index.map((s) => (s.running && Date.now() - s.updatedAt > 6 * 60_000 ? { ...s, running: false } : s));
}

export async function updateIndex(meta: SessionMeta | { id: string; remove: true }): Promise<void> {
  const index = ((await storeGetJson<SessionMeta[]>(INDEX)) ?? []).filter((s) => s.id !== meta.id);
  if (!("remove" in meta)) index.unshift({ id: meta.id, title: meta.title, updatedAt: meta.updatedAt, running: meta.running || undefined });
  await storePut(INDEX, JSON.stringify(index.slice(0, 300)));
}

/** Save the session; returns true if the user asked this run to stop. */
export async function saveSessionDoc(doc: SessionDoc, opts: { clearStop?: boolean } = {}): Promise<boolean> {
  return storePutAndTakeFlag(sessionPath(doc.id), JSON.stringify(doc), stopPath(doc.id), opts.clearStop);
}

export async function requestStop(id: string): Promise<void> {
  await storePut(stopPath(id), "1");
}
