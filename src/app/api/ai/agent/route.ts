import type { NextRequest } from "next/server";
import { aiConfigured, type ChatMessage } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { runOperator, type OperatorEvent } from "@/lib/operator";
import { audit } from "@/lib/security";

export const maxDuration = 300;

/**
 * POST /api/ai/agent { transcript, message?, approvals?: {callId: boolean}, model? }
 * Streams NDJSON events while the operator works; the last event carries the transcript to send back next time.
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) throw new HttpError(503, "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to use the assistant.");
  const body = await readJson<{ transcript?: unknown; message?: unknown; approvals?: unknown; model?: unknown }>(req, 2_000_000);
  const transcript = Array.isArray(body.transcript) ? (body.transcript as ChatMessage[]).slice(-300) : [];
  const message = typeof body.message === "string" && body.message.trim() ? body.message : undefined;
  const approvals =
    body.approvals && typeof body.approvals === "object"
      ? Object.fromEntries(Object.entries(body.approvals as Record<string, unknown>).map(([k, v]) => [k, v === true]))
      : undefined;
  const model = typeof body.model === "string" && /^[\w.-]{1,64}$/.test(body.model) ? body.model : undefined;
  if (!message && !approvals) throw new HttpError(400, "send a message or approvals");
  audit(req, "ai.operator", { message: message?.slice(0, 200), approvals });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: OperatorEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          /* client went away */
        }
        if (e.type === "tool") audit(req, "ai.tool", { label: e.label });
      };
      try {
        await runOperator({ transcript, message, approvals, model }, emit, req.signal);
      } catch (e) {
        emit({ type: "text", content: `Stopped: ${(e as Error).message}` });
        emit({ type: "done", transcript, waiting: false, paused: false });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
});
