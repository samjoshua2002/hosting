import type { NextRequest } from "next/server";
import { aiConfigured, chat, fastModel } from "@/lib/ai";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";

export const maxDuration = 60;

export interface Recommendation {
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  vm: string | null;
  command: string | null;
}

const PROMPT = `You review a snapshot of a small VM fleet (InstaBox sandboxes: 4 vCPU / 8 GB / 20 GB, auto-pause after 30 min idle,
2 h max runtime, unreachable usually means paused) and give the operator up to 4 short, specific, actionable recommendations
for reliability, cost/capacity, performance or security. Use real numbers from the snapshot. Skip generic advice.
If everything is healthy, say so in one "info" item and suggest one useful improvement.
Reply as JSON: {"recommendations":[{"title":string (max 70 chars),"detail":string (1-2 sentences),"severity":"info"|"warning"|"critical","vm":string|null,"command":string|null (one safe shell command the operator could run, or null)}]}`;

/** POST /api/ai/recommend { snapshot } → { recommendations } (fast model, no SSH: uses the dashboard's data). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) throw new HttpError(503, "Azure OpenAI is not configured");
  const { snapshot } = await readJson<{ snapshot?: unknown }>(req);
  const text = JSON.stringify(snapshot ?? {});
  if (text.length > 60_000) throw new HttpError(413, "snapshot too large");
  const res = await chat({
    model: fastModel(),
    json: true,
    maxTokens: 1500,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: text },
    ],
  });
  let recs: Recommendation[] = [];
  try {
    const parsed = JSON.parse(res.message.content ?? "{}") as { recommendations?: Partial<Recommendation>[] };
    recs = (parsed.recommendations ?? []).slice(0, 4).map((r) => ({
      title: String(r.title ?? "").slice(0, 100),
      detail: String(r.detail ?? "").slice(0, 400),
      severity: r.severity === "critical" || r.severity === "warning" ? r.severity : "info",
      vm: typeof r.vm === "string" ? r.vm : null,
      command: typeof r.command === "string" && r.command.trim() ? r.command.trim().slice(0, 1000) : null,
    }));
  } catch {
    throw new HttpError(502, "The model returned an unreadable answer");
  }
  return Response.json({ recommendations: recs, model: res.model, at: Date.now() });
});
