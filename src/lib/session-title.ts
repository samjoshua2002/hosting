// Short, meaningful session titles written by the fast model (from what happened, not the first message).
import { chat, fastModel } from "./ai";
import type { Item } from "./assistant-items";
import { getSessionDoc, listSessions, sessionPath, updateIndex } from "./sessions";
import { storePut } from "./store";

export /** 3–6 words that say what the session was about (not just the first message). */
async function titleFor(items: Item[]): Promise<string | null> {
  const user = items.filter((i): i is Extract<Item, { kind: "user" }> => i.kind === "user").map((i) => i.text);
  const did = items
    .filter((i) => i.kind === "step" || i.kind === "text" || i.kind === "artifact")
    .map((i) => (i.kind === "step" ? i.label : i.kind === "artifact" ? `artifact: ${i.title}` : i.kind === "text" ? i.text : ""))
    .join("\n")
    .slice(0, 2500);
  if (!user.length) return null;
  const r = await chat({
    model: fastModel(),
    maxTokens: 30,
    timeoutMs: 15_000,
    messages: [
      {
        role: "system",
        content:
          "You write titles for a chat history list. Reply with ONLY a title of 3 to 6 words in Title Case naming the subject or outcome (project, machine, task). No quotes, no punctuation at the end, no sentences, never answer the conversation.",
      },
      { role: "user", content: `<conversation>\nUser asked:\n${user.join("\n").slice(0, 1500)}\n\nWhat happened:\n${did}\n</conversation>\n\nTitle:` },
    ],
  });
  // first line only, at most 7 words: a title, never an answer
  const first = (r.message.content ?? "").split("\n").find((l) => l.trim()) ?? "";
  const words = first.replace(/^(title:\s*)/i, "").replace(/["'`*#]/g, "").trim().split(/\s+/);
  if (words.length > 7) return null;
  const t = words.join(" ").replace(/[.,;:!?]+$/, "").slice(0, 70);
  return t.length >= 3 ? t : null;
}

/** Give a few older sessions a real title (runs in the background after the list is read). */
export async function backfillTitles(limit = 4): Promise<void> {
  // untitled ones, plus any that got a sentence instead of a title
  const todo = (await listSessions()).filter((s) => !s.named && !s.running && (!s.titled || /\n|\.\s/.test(s.title) || s.title.split(" ").length > 8)).slice(0, limit);
  for (const m of todo) {
    const doc = await getSessionDoc(m.id).catch(() => null);
    if (!doc) continue;
    const t = await titleFor(doc.items).catch(() => null);
    doc.titled = true; // even if it failed, don't try forever
    if (t) doc.title = t;
    await storePut(sessionPath(m.id), JSON.stringify(doc));
    await updateIndex({ id: m.id, title: doc.title, titled: true });
  }
}
