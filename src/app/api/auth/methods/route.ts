import type { NextRequest } from "next/server";
import { authConfigured, getPasskeys, passwordLoginEnabled, relyingParty } from "@/lib/auth";
import { handle } from "@/lib/api";
import { mailConfigured } from "@/lib/mail";
import { zohoConfigured } from "@/lib/zoho";

/** Public: which sign-in methods the login page should offer on this domain. */
export const GET = handle(async (req: NextRequest) => {
  const { rpID } = relyingParty(req);
  return Response.json({
    configured: authConfigured(),
    password: passwordLoginEnabled(),
    passkey: getPasskeys().some((p) => p.rpID === rpID),
    zoho: zohoConfigured(),
    emailLink: mailConfigured(),
  });
});
