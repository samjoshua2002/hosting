import { generateRegistrationOptions, verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import type { NextRequest } from "next/server";
import { encodePasskey, getPasskeys, relyingParty, toB64url } from "@/lib/auth";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { challengeCookie, clearChallenge, readChallenge } from "@/lib/passkey";
import { audit } from "@/lib/security";

const USER_ID = new TextEncoder().encode("hosting-admin");

/**
 * POST { step: "options" } → registration options for this device.
 * POST { step: "verify", response, name } → verifies and returns the PASSKEYS entry to save.
 * Signed-in only: you add a passkey after logging in with the password (or another passkey).
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const body = await readJson<{ step?: string; response?: RegistrationResponseJSON; name?: string }>(req);
  const { rpID, origin } = relyingParty(req);
  const secure = req.nextUrl.protocol === "https:";

  if (body.step === "options") {
    const existing = getPasskeys().filter((p) => p.rpID === rpID);
    const options = await generateRegistrationOptions({
      rpName: "Hosting Control",
      rpID,
      userName: "admin",
      userDisplayName: "Hosting admin",
      userID: USER_ID,
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const res = Response.json(options);
    res.headers.append("Set-Cookie", await challengeCookie("reg", options.challenge, secure));
    return res;
  }

  if (body.step === "verify") {
    const challenge = await readChallenge(req, "reg");
    if (!challenge) throw new HttpError(400, "Registration expired, start again");
    if (!body.response) throw new HttpError(400, "Missing response");
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    }).catch((e: Error) => {
      throw new HttpError(400, `Passkey rejected: ${e.message}`);
    });
    if (!result.verified) throw new HttpError(400, "Passkey could not be verified");
    const { credential } = result.registrationInfo;
    const entry = encodePasskey({
      name: (body.name ?? "").trim() || "passkey",
      rpID,
      id: credential.id,
      publicKey: toB64url(credential.publicKey),
      transports: credential.transports ?? [],
    });
    const all = [...(process.env.PASSKEYS ?? "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean), entry].join(",");
    audit(req, "passkey.registered", { rpID, name: body.name });
    const res = Response.json({ entry, value: all, rpID });
    res.headers.append("Set-Cookie", clearChallenge());
    return res;
  }

  throw new HttpError(400, "unknown step");
});
