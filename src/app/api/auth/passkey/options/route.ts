import { generateAuthenticationOptions } from "@simplewebauthn/server";
import type { NextRequest } from "next/server";
import { authConfigured, getPasskeys, relyingParty } from "@/lib/auth";
import { handle, HttpError } from "@/lib/api";
import { challengeCookie } from "@/lib/passkey";

/** Public: start a passkey sign-in on this domain. */
export const GET = handle(async (req: NextRequest) => {
  if (!authConfigured()) throw new HttpError(503, "Auth is not configured");
  const { rpID } = relyingParty(req);
  const keys = getPasskeys().filter((p) => p.rpID === rpID);
  if (!keys.length) throw new HttpError(404, "No passkeys registered for this domain");
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports as AuthenticatorTransport[] })),
  });
  const res = Response.json(options);
  res.headers.append("Set-Cookie", await challengeCookie("auth", options.challenge, req.nextUrl.protocol === "https:"));
  return res;
});
