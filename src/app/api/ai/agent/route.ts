import { after, type NextRequest } from "next/server";
import { aiConfigured, type ChatMessage } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { applyEvent, settle, type Att, type Item, type OperatorEvent } from "@/lib/assistant-items";
import { runOperator } from "@/lib/operator";
import { audit } from "@/lib/security";
import { titleFor } from "@/lib/session-title";
import { listSessions, saveSessionDoc, SESSION_ID, sessionPath, updateIndex, type SessionDoc } from "@/lib/sessions";
import { storeGetJson } from "@/lib/store";

export const maxDuration = 300;

/**
 * POST /api/ai/agent { session, items, title, files, transcript, message?, approvals?, answers?, review?, model? }
 * Streams NDJSON events while the operator works. The run does not depend on this connection: it keeps going
 * if the tab closes or the user changes page, saves the session on the storage machine every round, and
 * stops when /api/ai/stop is called.
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) throw new HttpError(503, "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to use the assistant.");
  const body = await readJson<{
    transcript?: unknown;
    message?: unknown;
    approvals?: unknown;
    answers?: unknown;
    session?: unknown;
    model?: unknown;
    items?: unknown;
    title?: unknown;
    files?: unknown;
    review?: unknown;
    /** what the user typed (shown in the chat); message may carry extra [Context] for the model */
    display?: unknown;
    /** attachments sent with this message */
    staged?: unknown;
    source?: unknown;
  }>(req, 2_000_000);
  const transcript = Array.isArray(body.transcript) ? (body.transcript as ChatMessage[]).slice(-300) : [];
  const message = typeof body.message === "string" && body.message.trim() ? body.message : undefined;
  const approvals =
    body.approvals && typeof body.approvals === "object"
      ? Object.fromEntries(Object.entries(body.approvals as Record<string, unknown>).map(([k, v]) => [k, v === true]))
      : undefined;
  const answers =
    body.answers && typeof body.answers === "object"
      ? Object.fromEntries(Object.entries(body.answers as Record<string, unknown>).map(([k, v]) => [k, String(v).slice(0, 4000)]))
      : undefined;
  const sessionId = typeof body.session === "string" && SESSION_ID.test(body.session) ? body.session : undefined;
  const model = typeof body.model === "string" && /^[\w.-]{1,64}$/.test(body.model) ? body.model : undefined;
  const review = body.review === "manual" ? "manual" : "auto";
  if (!message && !approvals && !answers) throw new HttpError(400, "send a message, approvals or answers");
  audit(req, "ai.operator", { message: message?.slice(0, 200), approvals, review });

  // box5 holds the truth: start from the saved session and apply what this request changes
  const prev = sessionId ? await storeGetJson<SessionDoc>(sessionPath(sessionId)) : null; // missing → null; SSH trouble → error, never a silent reset
  if (prev?.running && Date.now() - prev.updatedAt < 6 * 60_000) throw new HttpError(409, "This session is still working. Wait for it or press Stop.");
  const clientFiles = Array.isArray(body.files) ? (body.files as Att[]) : [];
  const staged = Array.isArray(body.staged) ? (body.staged as Att[]).slice(0, 20) : [];
  let items: Item[] = prev?.items ?? [];
  if (approvals) items = items.map((i) => (i.kind === "approval" && approvals[i.id] !== undefined ? { ...i, decision: approvals[i.id] } : i));
  if (answers) items = items.map((i) => (i.kind === "question" && answers[i.id] !== undefined ? { ...i, answer: answers[i.id] } : i));
  if (message) {
    const shown = typeof body.display === "string" ? body.display.slice(0, 8000) : message;
    items = items.map((i) => (i.kind === "approval" && i.decision === undefined ? { ...i, decision: false } : i.kind === "question" && i.answer === undefined ? { ...i, answer: shown } : i));
    items.push({ kind: "user", text: shown, files: staged.length ? staged : undefined });
  }
  const attachments = [...(prev?.attachments ?? [])];
  for (const f of clientFiles) if (!attachments.some((a) => a.id === f.id)) attachments.push(f);
  const history = (prev?.transcript as ChatMessage[] | undefined) ?? transcript;

  const doc: SessionDoc = {
    ...(prev ? { pinned: prev.pinned, named: prev.named, titled: prev.titled, source: prev.source } : { source: body.source === "pipeline" ? ("pipeline" as const) : undefined }),
    id: sessionId ?? "",
    title: prev?.title ?? (typeof body.title === "string" ? body.title : "New session").slice(0, 120),
    updatedAt: Date.now(),
    running: true,
    items: items.slice(-500),
    transcript: history,
    attachments: attachments.slice(0, 200),
  };

  const stopper = new AbortController();
  // saves run one after another; each also tells us whether Stop was pressed
  let saving: Promise<void> = Promise.resolve();
  const save = (opts: { clearStop?: boolean } = {}) => {
    if (!sessionId) return saving;
    saving = saving
      .then(async () => {
        doc.updatedAt = Date.now();
        if (await saveSessionDoc(doc, opts)) stopper.abort();
      })
      .catch((e) => console.error("session save failed", e));
    return saving;
  };

  const encoder = new TextEncoder();
  const sink: { c?: ReadableStreamDefaultController<Uint8Array> } = {};
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      sink.c = c;
    },
    cancel() {
      open = false; // the tab went away; the run carries on
    },
  });

  const emit = (e: OperatorEvent) => {
    doc.items = applyEvent(doc.items, e);
    if (e.type === "done") doc.transcript = e.transcript;
    if (e.type === "tool") audit(req, "ai.tool", { label: e.label });
    if (!open) return;
    try {
      sink.c?.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
    } catch {
      open = false;
    }
  };

  const run = (async () => {
    if (sessionId) {
      await save({ clearStop: true });
      await updateIndex({ id: doc.id, title: doc.title, updatedAt: Date.now(), running: true, source: doc.source }).catch(() => {});
    }
    try {
      await runOperator({ transcript: history, message, approvals, answers, sessionId, model, review, onRound: () => save() }, emit, stopper.signal);
      if (stopper.signal.aborted) emit({ type: "text", content: "Stopped." });
    } catch (e) {
      emit({ type: "text", content: `Stopped: ${(e as Error).message}` });
      emit({ type: "done", transcript: doc.transcript, waiting: false, paused: false });
    }
    doc.items = settle(doc.items);
    doc.running = false;
    // the user may have renamed or pinned it while it ran
    if (sessionId) {
      const cur = (await listSessions().catch(() => [])).find((x) => x.id === doc.id);
      if (cur?.named) Object.assign(doc, { title: cur.title, named: true });
      if (cur) doc.pinned = cur.pinned;
    }
    // a real title once there's something to name (unless the user named it)
    if (sessionId && !doc.named && !doc.titled) {
      const t = await titleFor(doc.items).catch(() => null);
      if (t) {
        doc.title = t;
        doc.titled = true;
      }
    }
    if (sessionId) {
      await save();
      await updateIndex({ id: doc.id, title: doc.title, updatedAt: Date.now(), running: false, pinned: doc.pinned, named: doc.named, titled: doc.titled, source: doc.source }).catch(() => {});
    }
    if (open) {
      try {
        sink.c?.close();
      } catch {
        /* already closed */
      }
    }
  })();
  // keep the function alive until the run is finished, even if nobody is listening any more
  after(() => run);

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
});
