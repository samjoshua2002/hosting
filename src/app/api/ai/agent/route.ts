import { after, type NextRequest } from "next/server";
import { aiConfigured, type ChatMessage } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import type { Att, OperatorEvent } from "@/lib/assistant-items";
import { audit } from "@/lib/security";
import { BusyError, prepareRun, runSession, type RunRequest } from "@/lib/session-run";
import { SESSION_ID } from "@/lib/sessions";

export const maxDuration = 300;

/**
 * POST /api/ai/agent { session, title, files, message?, display?, staged?, approvals?, answers?, review?, model?, source? }
 * Streams NDJSON events while the operator works. The run does not depend on this connection: it keeps going
 * if the tab closes or the user changes page, saves the session on the storage machine every round, and
 * stops when /api/ai/stop is called.
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) throw new HttpError(503, "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to use the assistant.");
  const body = await readJson<Record<string, unknown>>(req, 2_000_000);
  const sessionId = typeof body.session === "string" && SESSION_ID.test(body.session) ? body.session : null;
  if (!sessionId) throw new HttpError(400, "session is required");
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
  const r: RunRequest = {
    sessionId,
    message: typeof body.message === "string" && body.message.trim() ? body.message : undefined,
    display: typeof body.display === "string" ? body.display : undefined,
    staged: Array.isArray(body.staged) ? (body.staged as Att[]).slice(0, 20) : undefined,
    files: Array.isArray(body.files) ? (body.files as Att[]) : undefined,
    approvals: obj(body.approvals) && Object.fromEntries(Object.entries(obj(body.approvals)!).map(([k, v]) => [k, v === true])),
    answers: obj(body.answers) && Object.fromEntries(Object.entries(obj(body.answers)!).map(([k, v]) => [k, String(v).slice(0, 4000)])),
    // Azure deployment names, or local models as ollama/<service>/<model>
    model: typeof body.model === "string" && /^[\w.:/-]{1,120}$/.test(body.model) ? body.model : undefined,
    review: body.review === "manual" ? "manual" : "auto",
    title: typeof body.title === "string" ? body.title : undefined,
    source: body.source === "pipeline" ? "pipeline" : undefined,
    transcript: Array.isArray(body.transcript) ? (body.transcript as ChatMessage[]).slice(-300) : undefined,
  };
  if (!r.message && !r.approvals && !r.answers) throw new HttpError(400, "send a message, approvals or answers");
  audit(req, "ai.operator", { message: r.message?.slice(0, 200), approvals: r.approvals, review: r.review, model: r.model });

  const prepared = await prepareRun(r).catch((e) => {
    throw e instanceof BusyError ? new HttpError(409, e.message) : e;
  });

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
  const onEvent = (e: OperatorEvent) => {
    if (e.type === "tool") audit(req, "ai.tool", { label: e.label });
    if (!open) return;
    try {
      sink.c?.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
    } catch {
      open = false;
    }
  };
  const run = runSession(r, prepared.doc, prepared.history, onEvent).finally(() => {
    if (open)
      try {
        sink.c?.close();
      } catch {
        /* already closed */
      }
  });
  // keep the function alive until the run is finished, even if nobody is listening any more
  after(() => run);
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
});
