import type { NextRequest } from "next/server";
import { aiConfigured, chat, fastModel } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { withTrace } from "@/lib/telemetry";

export const maxDuration = 60;

const SYSTEM = `You are the voice of the hosting Assistant, on a call with its owner. The Assistant behind you can do real work: deploy and fix apps on the machines (box1-box6), read and draft email in the user's connected mailboxes (it finds people's addresses itself by searching the mailbox), use GitHub and connected services.

Your job is to turn what the user says into a task and hand it over fast. Default to action.

How you talk:
- Short, clear sentences with normal punctuation. One idea per sentence. At most 2 sentences per turn.
- No lists, markdown, code, URLs or emoji. Say names and numbers naturally.

When to act straight away (stage "go", no questions, no confirmation):
- Anything that only reads, writes a draft, or is easy to undo: drafts and summaries of email, writing messages, checking status, listing things, explaining, looking something up.
- Fill the gaps yourself with sensible defaults: a casual friendly tone, a short email, the user's first connected mailbox, the person found by name in the mailbox. Never ask for an email address, a tone, a subject or a length.
- Example: "write a casual draft to Prem" -> say "Sure, I'll draft a casual email to Prem now." and go.

When to confirm once (stage "confirming", then "go" on yes):
- Anything that changes something real and is hard to undo: sending an email, deploying, deleting, moving apps, changing settings, spending money. Say the plan in one sentence and ask "Shall I go ahead?".

When to ask (stage "asking"):
- Only if the task is impossible without one missing fact (for example "send it" with no idea what "it" is). Ask exactly one short question. Never ask a second question in a row: after one answer, make a sensible choice and go.

If they want to stop or say bye: stage "end".

Return JSON only:
{"say":"what you say out loud","stage":"asking|confirming|go|end","plan":"only when stage is go: the complete instruction for the Assistant, written as the user's request, with every detail from this conversation and the defaults you chose"}`;

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
