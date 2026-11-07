import type { NextRequest } from "next/server";
import { authConfigured, getPasskeys, passwordLoginEnabled, relyingParty } from "@/lib/auth";
import { handle } from "@/lib/api";

/** Public: which sign-in methods the login page should offer on this domain. */
export const GET = handle(async (req: NextRequest) => {
  const { rpID } = relyingParty(req);
  return Response.json({
    configured: authConfigured(),
    password: passwordLoginEnabled(),
    passkey: getPasskeys().some((p) => p.rpID === rpID),
  });
});
