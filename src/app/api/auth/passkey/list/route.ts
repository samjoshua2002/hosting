import type { NextRequest } from "next/server";
import { getPasskeys, passwordLoginEnabled, relyingParty } from "@/lib/auth";
import { handle, requireAuth } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { aiConfigured } from "@/lib/ai";
import { alertRecipient, mailConfigured } from "@/lib/mail";

/** Security overview for the Security page (signed-in only). Never returns secret values. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const { rpID, origin } = relyingParty(req);
  const pw = process.env.ADMIN_PASSWORD ?? "";
  const recipient = alertRecipient() ?? "";
  return Response.json({
    rpID,
    origin,
    appUrlPinned: Boolean(process.env.APP_URL),
    passkeys: getPasskeys().map((p) => ({ name: p.name, rpID: p.rpID, id: `${p.id.slice(0, 10)}…`, here: p.rpID === rpID })),
    passwordLogin: passwordLoginEnabled(),
    passwordStrong: pw.length >= 16,
    https: origin.startsWith("https://"),
    hostKeyPinned: getConfig().vms.filter((v) => v.kind === "instabox").every((v) => v.hostKeys.length > 0),
    mail: mailConfigured(),
    mailTo: recipient.replace(/^(.{2}).*(@.*)$/, "$1…$2"),
    ai: aiConfigured(),
    cron: Boolean(process.env.CRON_SECRET),
  });
});
