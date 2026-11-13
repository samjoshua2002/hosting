import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import type { MailItem } from "@/lib/mail";
import { logEvents } from "@/lib/report";

const recent = new Map<string, number>(); // title → last sent (per instance)
const QUIET_MS = 30 * 60 * 1000;

/** POST /api/alerts/notify { items }: problems the dashboard noticed go into the next fleet report (no email each time). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const { items } = await readJson<{ items?: unknown }>(req);
  if (!Array.isArray(items)) throw new HttpError(400, "items must be an array");
  const now = Date.now();
  const fresh: MailItem[] = items
    .filter((i): i is MailItem => typeof i === "object" && i !== null && typeof (i as MailItem).title === "string")
    .slice(0, 20)
    .map((i) => ({
      tone: (["critical", "warning", "good", "info"] as const).includes(i.tone) ? i.tone : "warning",
      title: i.title.slice(0, 140),
      detail: typeof i.detail === "string" ? i.detail.slice(0, 500) : undefined,
    }))
    .filter((i) => now - (recent.get(i.title) ?? 0) > QUIET_MS);
  if (!fresh.length) return Response.json({ sent: false, reason: "duplicate" });
  fresh.forEach((i) => recent.set(i.title, now));
  await logEvents(fresh.map((i) => ({ kind: i.tone === "good" ? ("fixed" as const) : i.tone === "info" ? ("notice" as const) : ("problem" as const), text: i.detail ? `${i.title}: ${i.detail}` : i.title })));
  return Response.json({ sent: false, logged: fresh.length });
});
