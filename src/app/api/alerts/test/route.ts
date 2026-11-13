import type { NextRequest } from "next/server";
import { handle, HttpError, requireAuth } from "@/lib/api";
import { mailConfigured } from "@/lib/mail";
import { maybeSendReport } from "@/lib/report";

export const maxDuration = 120;

/** POST /api/alerts/test: send the fleet report now (what the regular one looks like). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!mailConfigured()) throw new HttpError(503, "Set EMAIL_USER and EMAIL_PASS first");
  const r = await maybeSendReport({ force: true });
  if (!r.sent) throw new HttpError(502, `The report didn't go out: ${r.reason ?? "check EMAIL_PASS (a Gmail app password) in the server logs"}`);
  return Response.json({ ok: true, subject: r.subject });
});
