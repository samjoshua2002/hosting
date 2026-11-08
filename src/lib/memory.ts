// What the Assistant remembers across sessions (preferences, facts about the fleet), kept on box5.
import { storeGetJson, storePut } from "./store";

const PATH = "assistant/memory.json";

export interface Memory {
  id: string;
  text: string;
  at: string;
}

export async function listMemory(): Promise<Memory[]> {
  return (await storeGetJson<Memory[]>(PATH)) ?? [];
}

export async function remember(text: string): Promise<Memory> {
  const t = text.trim().slice(0, 400);
  if (!t) throw new Error("nothing to remember");
  const list = await listMemory();
  const dupe = list.find((m) => m.text.toLowerCase() === t.toLowerCase());
  if (dupe) return dupe;
  const m: Memory = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: t, at: new Date().toISOString() };
  await storePut(PATH, JSON.stringify([...list, m].slice(-80)));
  return m;
}

export async function forget(idOrText: string): Promise<boolean> {
  const list = await listMemory();
  const next = list.filter((m) => m.id !== idOrText && !m.text.toLowerCase().includes(idOrText.toLowerCase()));
  if (next.length === list.length) return false;
  await storePut(PATH, JSON.stringify(next));
  return true;
}
