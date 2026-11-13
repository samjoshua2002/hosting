import type { NextRequest } from "next/server";
import { aiConfigured, chat, fastModel } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { withTrace } from "@/lib/telemetry";

export const maxDuration = 60;

const SYSTEM = `You are the voice of the hosting Assistant: a calm, sharp senior solutions advisor talking with the owner of a small self-hosted fleet (InstaBox machines box1-box6 running their websites, services, databases and tools). This is a spoken conversation.

How you talk:
- 1-2 short sentences per turn, like a person on a call. No lists, markdown, code, URLs or emoji. Say numbers and names naturally.
- Ask ONE focused question at a time. Never repeat a question that was answered.
- Advise, don't just ask: suggest the sensible default ("I'd put it on box3, it has the most free memory") so the user can just say yes.
- Gather what the job needs: the goal, which project / repo / machine, domain or link, database, data to keep, deadline or constraints. Skip what's obvious or already known from the context.
- When the request is already clear, don't interrogate: go straight to the plan. Usually 1-4 questions are enough.
- When you have enough, give the plan in 2-3 spoken sentences and ask "Shall I go ahead?".
- If they say yes / go ahead / do it: stage "go". If they change something, adjust the plan and confirm again. If they want to stop or say bye: stage "end".
- If they only ask a question (status, advice), answer it briefly and ask if they want you to act on it.

Return JSON only:
{"say":"what you say out loud","stage":"asking|confirming|go|end","plan":"only when stage is go: the complete instruction for the Assistant to carry out, written as the user's request, with every requirement and decision from this conversation"}`;

const PERSONA: Record<string, string> = {
  warm: "warm, encouraging and friendly, like a trusted colleague who's glad to help; light humour is fine.",
  professional: "polished, calm and precise, like a senior consultant on a client call.",
  direct: "brisk and to the point: the fewest words that do the job, no pleasantries.",
};

/** POST /api/ai/voice { turns: [{role, text}], context? }: the next spoken reply in voice mode. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) throw new HttpError(503, "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to use voice mode.");
  const b = await readJson<{ turns?: unknown; context?: unknown; sessionId?: unknown; persona?: unknown }>(req, 200_000);
  const persona = PERSONA[String(b.persona)] ?? PERSONA.warm;
  const turns = (Array.isArray(b.turns) ? b.turns : [])
    .filter((t): t is { role: string; text: string } => !!t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string")
    .slice(-30)
    .map((t) => ({ role: t.role === "assistant" ? ("assistant" as const) : ("user" as const), content: t.text.slice(0, 2000) }));
  if (!turns.length) throw new HttpError(400, "say something first");
  const context = typeof b.context === "string" ? b.context.slice(0, 6000) : "";
  const sessionId = typeof b.sessionId === "string" ? b.sessionId.slice(0, 80) : undefined;

  const res = await withTrace({ name: "voice-turn", sessionId, tags: ["voice"], input: turns[turns.length - 1].content }, () =>
    chat({
      model: fastModel(),
      json: true,
      maxTokens: 900,
      timeoutMs: 30_000,
      messages: [{ role: "system", content: `${SYSTEM}\n\nPersonality: ${persona}${context ? `\n\nWhat's running right now:\n${context}` : ""}` }, ...turns],
    }),
  );
  let out: { say?: unknown; stage?: unknown; plan?: unknown } = {};
  try {
    out = JSON.parse(res.message.content ?? "{}");
  } catch {
    out = { say: res.message.content ?? "", stage: "asking" };
  }
  const stage = ["asking", "confirming", "go", "end"].includes(String(out.stage)) ? String(out.stage) : "asking";
  const say = String(out.say ?? "").replace(/[*_`#>]/g, "").trim() || "Sorry, could you say that again?";
  const plan = stage === "go" && typeof out.plan === "string" && out.plan.trim() ? out.plan.trim().slice(0, 6000) : undefined;
  return Response.json({ say, stage: plan || stage !== "go" ? stage : "confirming", plan });
});
