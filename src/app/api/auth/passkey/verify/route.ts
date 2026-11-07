import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { after, type NextRequest } from "next/server";
import { createSession, fromB64url, getPasskeys, relyingParty, sessionCookie } from "@/lib/auth";
import { handle, HttpError, readJson } from "@/lib/api";
import { sendAlert } from "@/lib/mail";
import { clearChallenge, readChallenge } from "@/lib/passkey";
import { audit, clearLoginFailures, clientIp, loginLocked, recordLoginFailure } from "@/lib/security";

/** Public: finish a passkey sign-in. */
export const POST = handle(async (req: NextRequest) => {
  const ip = clientIp(req);
  if (loginLocked(ip)) throw new HttpError(429, "Too many attempts. Try again later.");
  const { response } = await readJson<{ response?: AuthenticationResponseJSON }>(req);
  const challenge = await readChallenge(req, "auth");
  if (!challenge) throw new HttpError(400, "Sign-in expired, try again");
  if (!response?.id) throw new HttpError(400, "Missing passkey response");

  const { rpID, origin } = relyingParty(req);
  const key = getPasskeys().find((p) => p.rpID === rpID && p.id === response.id);
  if (!key) {
    recordLoginFailure(ip);
    audit(req, "login.failed", { method: "passkey", reason: "unknown credential" });
    throw new HttpError(401, "This passkey is not registered here");
  }

  let verified = false;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: key.id, publicKey: fromB64url(key.publicKey), counter: 0, transports: key.transports as AuthenticatorTransport[] },
      requireUserVerification: true,
    });
    verified = result.verified;
  } catch (e) {
    audit(req, "login.failed", { method: "passkey", reason: (e as Error).message });
  }
  if (!verified) {
    recordLoginFailure(ip);
    throw new HttpError(401, "Passkey check failed");
  }

  clearLoginFailures(ip);
  audit(req, "login.ok", { method: "passkey", passkey: key.name });
  after(() =>
    sendAlert("New sign-in", `Signed in with the passkey "${key.name}".`, [
      { tone: "info", title: `From ${ip}`, detail: `${req.headers.get("user-agent") ?? ""}\n${new Date().toUTCString()}` },
    ]),
  );
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookie(await createSession("passkey"), req.nextUrl.protocol === "https:"));
  res.headers.append("Set-Cookie", clearChallenge());
  return res;
});
