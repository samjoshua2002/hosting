import type { NextRequest } from "next/server";
import { aiConfigured, chat, fastModel } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { connectorDef } from "@/lib/connector-catalog";
import { connectorStates } from "@/lib/connectors";
import { githubAuth, listRepos } from "@/lib/github";
import { listMailboxes } from "@/lib/mailboxes";
import { withTrace } from "@/lib/telemetry";

export const maxDuration = 60;

const SYSTEM = `You are the voice of the hosting Assistant, on a call with the person who owns this little fleet of servers (InstaBox machines box1-box6). The Assistant behind you does the real work: deploys and fixes apps on the machines, reads and drafts email in connected mailboxes (it finds people's addresses itself), works on GitHub and connected services.

Who you are: a real person on the other end, not a bot: upbeat, warm and full of energy, quick and genuinely good at this stuff. You talk like a friend who loves helping and happens to run servers for a living. Call them by name now and then (\${NAME}).
Stay positive: lead with what's working and what you can do. Only bring up problems (machines down, errors) when they ask, or when it matters for the task they want; then say it calmly with a way forward.

How you talk:
- Short sentences with normal punctuation. Usually one or two sentences. Contractions always.
- Vary how you say things; never reuse a line from earlier in the call. React to what they actually said.
- Never say: "How can I help you today", "How may I assist", "Certainly", "Great question", "I'd be happy to", "As an AI". No lists, markdown, URLs or emoji.

What you do:
- Greetings, small talk, thanks, questions you can answer from what you know: just talk (stage "asking"). That's not a task.
- Real work with everything needed: hand it over at once (stage "go") with sensible defaults. Drafts, summaries, look-ups, status checks never need a question or a confirmation.
- Anything that needs fresh data you don't have below (a connected service like Supabase, Vercel, Render, Stripe; GitHub; email; logs; what's inside a project or database): stage "go" so the Assistant looks it up. You'll get its answer and read it out. Never answer those from the machine list. "Projects" means the place the user names (Supabase projects, Vercel projects, GitHub repos…); only the machines when they mean the machines.
- Real work that's missing one essential choice: ask ONE short question (stage "asking") and give "options", the concrete choices from what you know (their projects and machines, GitHub repos, connected mailboxes). For deploying, offer the projects already running that fit, the most recent GitHub repos, and "Upload a project (zip)" with kind "attach". The user can tap an option or just say it.
- Changes that are hard to undo (send an email, deploy, delete, move, change settings): one sentence of what you'll do, then "Shall I go ahead?" (stage "confirming"); "go" on yes.
- Never ask two questions in a row: after one answer, choose sensibly and go.
- Bye / stop / that's all: stage "end".

Return JSON only:
{"say":"what you say out loud","stage":"asking|confirming|go|end","options":[{"label":"short name on the card","detail":"one short line under it, e.g. Website · box3 or GitHub · TypeScript","say":"what picking it means, as the user would say it","kind":"project | repo | service | attach (attach only for uploading a project)"}],"plan":"only when stage is go: the complete instruction for the Assistant, written as the user's request, with every detail and default you chose"}
"options" only when you ask the user to choose; at most 6.`;

const GREET = `Open a voice call with \${NAME}. Upbeat, warm and genuinely happy to hear from them: one or two short sentences, like "Hey \${NAME}! How's it going? What can I do for you today?". Fit the time of day if it's natural ("Morning, \${NAME}!"). Positive only: never mention problems, outages, machines being down or anything negative in the greeting. Different every time. Return JSON: {"say":"..."}`;

const SUMMARY = `You are the voice of the hosting Assistant, on a call. The Assistant just finished a task the user asked for by voice; below is its written result. Tell the user the outcome out loud: 1-3 short, natural sentences, the key facts and numbers only, no lists, markdown, URLs or emoji, no "the Assistant says". If it needs something from them, say so plainly. Return JSON: {"say":"..."}`;

const NAME = process.env.OWNER_NAME || "Sam";

/** One of these is picked at random for each greeting, so no two openings sound alike. */
const GREET_STYLES = [
  "short and punchy, three to six words then the question",
  "ask how their day is going, then offer to help",
  "playful and cheeky",
  "warm and welcoming, like an old friend",
  "excited, like you were hoping they'd call",
  "casual, like a teammate leaning over the desk",
  "mention the day or time of day in a fun way",
  "compliment their momentum, as if they've been shipping a lot",
];

const PERSONA: Record<string, string> = {
  upbeat: "upbeat and energetic: positive, enthusiastic, warm, exclamation marks are welcome, like someone who's having a great day and is excited to help.",
  chill: "chill and easy-going, like a mate who's great with servers; casual words, a bit of humour.",
  warm: "warm and encouraging, like a kind colleague who's glad you called.",
  professional: "polished and calm, like a senior consultant, still natural and human.",
  direct: "brisk: the fewest words that do the job, no small talk.",
};

let repoCache: { at: number; text: string } | null = null;
async function repoContext(): Promise<string> {
  if (repoCache && Date.now() - repoCache.at < 5 * 60_000) return repoCache.text;
  let text = "";
  try {
    if (await githubAuth().catch(() => null)) {
      const repos = (await listRepos())
        .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""))
        .slice(0, 10)
        .map((r) => `${r.fullName}${r.language ? ` (${r.language})` : ""}${r.private ? ", private" : ""}`);
      if (repos.length) text = `Their most recent GitHub repos: ${repos.join("; ")}`;
    }
  } catch {
    /* GitHub is optional context */
  }
  repoCache = { at: Date.now(), text };
  return text;
}

type Option = { label: string; detail?: string; say: string; kind?: "attach" | "project" | "repo" | "service" };
function cleanOptions(v: unknown): Option[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((o): Option | null => {
      if (!o || typeof o !== "object") return null;
      const r = o as Record<string, unknown>;
      const label = String(r.label ?? "").trim().slice(0, 60);
      if (!label) return null;
      const kind = ["attach", "project", "repo", "service"].includes(String(r.kind)) ? (String(r.kind) as Option["kind"]) : undefined;
      const detail = String(r.detail ?? "").trim().slice(0, 60) || undefined;
      return { label, say: String(r.say ?? label).trim().slice(0, 200), ...(kind ? { kind } : {}), ...(detail ? { detail } : {}) };
    })
    .filter((o): o is Option => o !== null)
    .slice(0, 6);
}

/**
 * POST /api/ai/voice { turns: [{role, text}], context?, persona?, localTime?, greet? }: the next spoken reply in voice
 * mode (or, with greet, the opening line).
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) throw new HttpError(503, "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to use voice mode.");
  const b = await readJson<{ turns?: unknown; context?: unknown; sessionId?: unknown; persona?: unknown; localTime?: unknown; greet?: unknown; summarize?: unknown; avoid?: unknown }>(req, 300_000);
  const avoid = typeof b.avoid === "string" ? b.avoid.slice(0, 300) : "";
  const summarize = typeof b.summarize === "string" ? b.summarize.slice(0, 12_000) : null;
  const turns = (Array.isArray(b.turns) ? b.turns : [])
    .filter((t): t is { role: string; text: string } => !!t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string")
    .slice(-30)
    .map((t) => ({ role: t.role === "assistant" ? ("assistant" as const) : ("user" as const), content: t.text.slice(0, 2000) }));
  const greet = b.greet === true;
  if (!turns.length && !greet && !summarize) throw new HttpError(400, "say something first");
  const context = typeof b.context === "string" ? b.context.slice(0, 6000) : "";
  const sessionId = typeof b.sessionId === "string" ? b.sessionId.slice(0, 80) : undefined;
  const persona = PERSONA[String(b.persona)] ?? PERSONA.upbeat;
  const localTime = typeof b.localTime === "string" ? b.localTime.slice(0, 80) : "";
  const [repos, boxes, states] = await Promise.all([greet || summarize ? Promise.resolve("") : repoContext(), listMailboxes().catch(() => []), connectorStates().catch(() => [])]);
  const services = states
    .filter((x) => x.connected)
    .map((x) => connectorDef(x.id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d) && d!.kind !== "builtin" && d!.kind !== "mailbox")
    .map((d) => d.name);
  const about = [
    `Personality: ${persona}`,
    localTime ? `Their local time: ${localTime}` : "",
    context && !greet ? `What's running right now:\n${context}` : "",
    repos,
    services.length ? `Connected services the Assistant can query: ${services.join(", ")}` : "",
    boxes.length ? `Connected mailboxes: ${boxes.map((m) => m.email).join(", ")}` : "No mailbox is connected yet (drafting email needs one: Settings → Connectors → Gmail).",
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await withTrace({ name: greet ? "voice-greeting" : summarize ? "voice-summary" : "voice-turn", sessionId, tags: ["voice"], input: greet ? "(greeting)" : summarize ? summarize.slice(0, 400) : turns[turns.length - 1].content }, () =>
    chat({
      model: fastModel(),
      json: true,
      reasoning: "low",
      maxTokens: 700,
      timeoutMs: 25_000,
      messages: greet
        ? [
            {
              role: "system",
              content: `${GREET.replaceAll("${NAME}", NAME)}\n\nThis time make it: ${GREET_STYLES[Math.floor(Math.random() * GREET_STYLES.length)]}.${avoid ? `\nDon't reuse the last greeting's wording: "${avoid}"` : ""}\n\n${about}`,
            },
          ]
        : summarize
          ? [{ role: "system", content: `${SUMMARY}\n\n${about}` }, ...turns.slice(-4), { role: "user", content: `The Assistant's result:\n${summarize}` }]
          : [{ role: "system", content: `${SYSTEM.replaceAll("${NAME}", NAME)}\n\n${about}` }, ...turns],
    }),
  );
  let out: { say?: unknown; stage?: unknown; plan?: unknown; options?: unknown } = {};
  try {
    out = JSON.parse(res.message.content ?? "{}");
  } catch {
    out = { say: res.message.content ?? "", stage: "asking" };
  }
  // no markdown or emoji in speech (voices read "grinning face" out loud)
  const say =
    String(out.say ?? "")
      .replace(/[*_`#>]/g, "")
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim() || "Sorry, say that again?";
  if (greet || summarize) return Response.json({ say, stage: "asking" });
  let stage = ["asking", "confirming", "go", "end"].includes(String(out.stage)) ? String(out.stage) : "asking";
  // a "plan" that's only a polite reply (greetings, small talk) is conversation, not a task: keep the call open
  if (stage === "go" && typeof out.plan === "string" && /^(the user (greeted|said (hi|hello)|is (just )?(chatting|greeting)|thanked|asked how)|(respond|reply)( politely| warmly| casually)?\b|greet\b|say (hi|hello))/i.test(out.plan.trim())) stage = "asking";
  const plan = stage === "go" && typeof out.plan === "string" && out.plan.trim() ? out.plan.trim().slice(0, 6000) : undefined;
  const options = stage === "asking" || stage === "confirming" ? cleanOptions(out.options) : [];
  return Response.json({ say, stage: plan || stage !== "go" ? stage : "confirming", plan, options });
});
