import type { NextRequest } from "next/server";
import { handle, HttpError, requireAuth } from "@/lib/api";
import { alertRecipient, mailConfigured, sendAlert } from "@/lib/mail";

/** POST /api/alerts/test sends a test email. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!mailConfigured()) throw new HttpError(503, "Set EMAIL_USER and EMAIL_PASS first");
  const ok = await sendAlert("Test alert", "Email alerts from your hosting dashboard are working.", [
    { tone: "good", title: "SMTP connection OK", detail: `Delivered to ${alertRecipient()}` },
  ]);
  if (!ok) throw new HttpError(502, "Sending failed: check EMAIL_PASS (a Gmail app password) in the server logs");
  return Response.json({ ok: true });
});
