import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { mailConfigured, sendAlert, type MailItem } from "@/lib/mail";

const recent = new Map<string, number>(); // title → last sent (per instance)
const QUIET_MS = 30 * 60 * 1000;

/** POST /api/alerts/notify { items } emails new problems the dashboard noticed (deduped for 30 min). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!mailConfigured()) return Response.json({ sent: false, reason: "mail not configured" });
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
  const critical = fresh.some((i) => i.tone === "critical");
  const sent = await sendAlert(
    critical ? `${fresh.length} problem${fresh.length > 1 ? "s" : ""} need attention` : "Fleet change detected",
    "Your dashboard just noticed:",
    fresh,
  );
  return Response.json({ sent });
});
