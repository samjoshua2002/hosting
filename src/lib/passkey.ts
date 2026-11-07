import type { NextRequest } from "next/server";
import { CHALLENGE_COOKIE, sign, unsign } from "./auth";

const TTL = 300;

export async function challengeCookie(kind: "auth" | "reg", challenge: string, secure: boolean): Promise<string> {
  const value = await sign(`${kind}-${challenge}`, TTL);
  return `${CHALLENGE_COOKIE}=${value}; Path=/api/auth/passkey; HttpOnly; SameSite=Strict; Max-Age=${TTL}${secure ? "; Secure" : ""}`;
}

/** The challenge this browser was issued (single use: the caller clears the cookie). */
export async function readChallenge(req: NextRequest, kind: "auth" | "reg"): Promise<string | null> {
  const payload = await unsign(req.cookies.get(CHALLENGE_COOKIE)?.value);
  if (!payload?.startsWith(`${kind}-`)) return null;
  return payload.slice(kind.length + 1);
}

export function clearChallenge(): string {
  return `${CHALLENGE_COOKIE}=; Path=/api/auth/passkey; HttpOnly; SameSite=Strict; Max-Age=0`;
}
