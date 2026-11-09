// Running the Assistant on a session: start from box5's copy, apply this request, run, save every round,
// title it, and finish. Used by the chat (streaming) and by Autopilot (no browser at all).
import type { ChatMessage } from "./ai";
import { applyEvent, settle, type Att, type Item, type OperatorEvent } from "./assistant-items";
import { maskTokens } from "./machines";
import { displayMasked, vaultText } from "./vault";
import { runOperator } from "./operator";
import { titleFor } from "./session-title";
import { listSessions, saveSessionDoc, sessionPath, updateIndex, type SessionDoc } from "./sessions";
import { storeGetJson } from "./store";

export interface RunRequest {
  sessionId: string;
  message?: string;
  /** what the user typed (shown in the chat); message may carry extra [Context] for the model */
  display?: string;
  staged?: Att[];
  files?: Att[];
  approvals?: Record<string, boolean>;
  answers?: Record<string, string>;
  model?: string;
  review: "auto" | "manual";
  title?: string;
  source?: SessionDoc["source"];
  /** only for a brand-new session that has history elsewhere */
  transcript?: ChatMessage[];
}

export class BusyError extends Error {}

/** Load the session and apply the request. Throws BusyError if a run is already going on. */
export async function prepareRun(r: RunRequest): Promise<{ doc: SessionDoc; history: ChatMessage[] }> {
  // machine tokens never reach a model or the saved chat, whichever page sent them
  if (r.message) r.message = await vaultText(maskTokens(r.message));
  // the chat shows "••••(NAME, saved)" where a secret was
  if (r.display) r.display = displayMasked(await vaultText(maskTokens(r.display)));
  const prev = await storeGetJson<SessionDoc>(sessionPath(r.sessionId)); // missing → null; SSH trouble → error, never a silent reset
  if (prev?.running && Date.now() - prev.updatedAt < 6 * 60_000) throw new BusyError("This session is still working. Wait for it or press Stop.");
  let items: Item[] = prev?.items ?? [];
  const { approvals, answers } = r;
  if (approvals) items = items.map((i) => (i.kind === "approval" && approvals[i.id] !== undefined ? { ...i, decision: approvals[i.id] } : i));
  if (answers) items = items.map((i) => (i.kind === "question" && answers[i.id] !== undefined ? { ...i, answer: answers[i.id] } : i));
  if (r.message) {
    const shown = (r.display ?? r.message).slice(0, 8000);
    items = items.map((i) => (i.kind === "approval" && i.decision === undefined ? { ...i, decision: false } : i.kind === "question" && i.answer === undefined ? { ...i, answer: shown } : i));
    items.push({ kind: "user", text: shown, files: r.staged?.length ? r.staged : undefined });
  }
  const attachments = [...(prev?.attachments ?? [])];
  for (const f of r.files ?? []) if (!attachments.some((a) => a.id === f.id)) attachments.push(f);
  const history = (prev?.transcript as ChatMessage[] | undefined) ?? r.transcript ?? [];
  const doc: SessionDoc = {
    ...(prev ? { pinned: prev.pinned, named: prev.named, titled: prev.titled, source: prev.source } : { source: r.source }),
    id: r.sessionId,
    title: prev?.title ?? (r.title ?? "New session").slice(0, 120),
    updatedAt: Date.now(),
    running: true,
    items: items.slice(-500),
    transcript: history,
    attachments: attachments.slice(0, 200),
  };
  return { doc, history };
}

/** Run the operator on a prepared session. onEvent receives every event (for a live stream). */
export async function runSession(r: RunRequest, doc: SessionDoc, history: ChatMessage[], onEvent?: (e: OperatorEvent) => void): Promise<void> {
  const stopper = new AbortController();
  // saves run one after another; each also tells us whether Stop was pressed
  let saving: Promise<void> = Promise.resolve();
  const save = (opts: { clearStop?: boolean } = {}) => {
    saving = saving
      .then(async () => {
        doc.updatedAt = Date.now();
        if (await saveSessionDoc(doc, opts)) stopper.abort();
      })
      .catch((e) => console.error("session save failed", e));
    return saving;
  };
  const emit = (e: OperatorEvent) => {
    doc.items = applyEvent(doc.items, e);
    if (e.type === "done") doc.transcript = e.transcript;
    onEvent?.(e);
  };

  await save({ clearStop: true });
  await updateIndex({ id: doc.id, title: doc.title, updatedAt: Date.now(), running: true, source: doc.source }).catch(() => {});
  try {
    await runOperator(
      { transcript: history, message: r.message, approvals: r.approvals, answers: r.answers, sessionId: doc.id, model: r.model, review: r.review, onRound: () => save() },
      emit,
      stopper.signal,
    );
    if (stopper.signal.aborted) emit({ type: "text", content: "Stopped." });
  } catch (e) {
    emit({ type: "text", content: `Stopped: ${(e as Error).message}` });
    emit({ type: "done", transcript: doc.transcript, waiting: false, paused: false });
  }
  doc.items = settle(doc.items);
  doc.running = false;
  // the user may have renamed or pinned it while it ran
  const cur = (await listSessions().catch(() => [])).find((x) => x.id === doc.id);
  if (cur?.named) Object.assign(doc, { title: cur.title, named: true });
  if (cur) doc.pinned = cur.pinned;
  // a real title once there's something to name (unless the user named it)
  if (!doc.named && !doc.titled) {
    const t = await titleFor(doc.items).catch(() => null);
    if (t) {
      doc.title = t;
      doc.titled = true;
    }
  }
  await save();
  await updateIndex({ id: doc.id, title: doc.title, updatedAt: Date.now(), running: false, pinned: doc.pinned, named: doc.named, titled: doc.titled, source: doc.source }).catch(() => {});
}
