// Assistant sessions on the storage machine: one JSON document per session plus a small index.
import type { Att, Item } from "./assistant-items";
import { storeDelete, storeGetJson, storePut, storePutAndTakeFlag, storeReadJsonDir } from "./store";

export const SESSION_ID = /^[a-z0-9-]{8,64}$/;
const INDEX = "sessions/index.json";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** a run is going on right now (saved by the server while it works) */
  running?: boolean;
  /** kept at the top of the list */
  pinned?: boolean;
  /** the user named it, so it's never retitled */
  named?: boolean;
  /** the AI already gave it a title */
  titled?: boolean;
  /** started from the Pipeline's AI bar, or by Autopilot */
  source?: "pipeline" | "autopilot";
}

export interface SessionDoc extends SessionMeta {
  items: Item[];
  transcript: unknown[];
  attachments: Att[];
}

export const sessionPath = (id: string) => `sessions/${id}.json`;
const stopPath = (id: string) => `sessions/${id}.stop`;

const metaPath = (id: string) => `sessions/meta/${id}.json`;
const order = (a: SessionMeta, b: SessionMeta) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt;

/**
 * One small file per session (sessions/meta/<id>.json), so editing one session never overwrites
 * another's flags. The old single index.json is migrated on first read.
 */
export async function listSessions(): Promise<SessionMeta[]> {
  let metas = (await storeReadJsonDir<SessionMeta>("sessions/meta")).map((x) => x.value);
  if (!metas.length) {
    const old = (await storeGetJson<SessionMeta[]>(INDEX)) ?? [];
    for (const m of old) await storePut(metaPath(m.id), JSON.stringify(m));
    // once only: otherwise deleting the last session would bring the old list back
    if (old.length) await storeDelete(INDEX).catch(() => {});
    metas = old;
  }
  // a run that stopped saving long ago crashed or timed out
  return metas.map((s) => (s.running && Date.now() - s.updatedAt > 6 * 60_000 ? { ...s, running: false } : s)).sort(order);
}

/** Upsert (keeping flags not given) or remove one session's list entry. */
export async function updateIndex(meta: (Partial<SessionMeta> & { id: string }) | { id: string; remove: true }): Promise<void> {
  if ("remove" in meta) return storeDelete(metaPath(meta.id));
  const old = await storeGetJson<SessionMeta>(metaPath(meta.id)).catch(() => null);
  const next: SessionMeta = { ...old, ...meta, title: meta.title ?? old?.title ?? "New session", updatedAt: meta.updatedAt ?? old?.updatedAt ?? Date.now() };
  for (const k of ["running", "pinned", "named", "titled", "source"] as const) if (next[k] === undefined || next[k] === false) delete next[k];
  await storePut(metaPath(meta.id), JSON.stringify(next));
}

export async function getSessionDoc(id: string): Promise<SessionDoc | null> {
  return storeGetJson<SessionDoc>(sessionPath(id));
}

/** Rename and/or pin; the document and the index stay in step. */
export async function editSession(id: string, edit: { title?: string; pinned?: boolean }): Promise<SessionMeta> {
  const doc = await getSessionDoc(id);
  if (!doc) throw new Error("session not found");
  if (edit.title !== undefined) {
    doc.title = edit.title.trim().slice(0, 120) || doc.title;
    doc.named = true;
  }
  if (edit.pinned !== undefined) doc.pinned = edit.pinned;
  await storePut(sessionPath(id), JSON.stringify(doc));
  const meta = { id, title: doc.title, updatedAt: doc.updatedAt, pinned: doc.pinned || undefined, named: doc.named || undefined, titled: doc.titled || undefined, source: doc.source };
  await updateIndex(meta);
  return meta;
}

/** Save the session; returns true if the user asked this run to stop. */
export async function saveSessionDoc(doc: SessionDoc, opts: { clearStop?: boolean } = {}): Promise<boolean> {
  return storePutAndTakeFlag(sessionPath(doc.id), JSON.stringify(doc), stopPath(doc.id), opts.clearStop);
}

export async function requestStop(id: string): Promise<void> {
  await storePut(stopPath(id), "1");
}
