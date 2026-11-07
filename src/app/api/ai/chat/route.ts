import type { NextRequest } from "next/server";
import { aiConfigured } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { runAgent } from "@/lib/ops-agent";
import { audit } from "@/lib/security";

export const maxDuration = 240;

/** POST /api/ai/chat { messages: [{role, content}], model? } → { reply, steps, proposals, model } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) throw new HttpError(503, "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to use the agent.");
  const body = await readJson<{ messages?: unknown; model?: unknown }>(req);
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        typeof m === "object" && m !== null && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") throw new HttpError(400, "send a user message");
  const model = typeof body.model === "string" && /^[\w.-]{1,64}$/.test(body.model) ? body.model : undefined;
  audit(req, "ai.chat", { prompt: messages[messages.length - 1].content.slice(0, 200), model });
  return Response.json(await runAgent(messages, model));
});
