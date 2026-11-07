// Sessions, signed challenges and passkey config. Web Crypto only, so it runs in proxy and route handlers.
// The signing key mixes SESSION_SECRET with ADMIN_PASSWORD: changing either one signs everyone out.

export const SESSION_MAX_AGE = 60 * 60 * 12; // 12 hours
const COOKIE_PLAIN = "hosting_session";
const COOKIE_SECURE = "__Host-hosting_session"; // __Host-: Secure, Path=/, no Domain → can't be set by subdomains
export const CHALLENGE_COOKIE = "hosting_webauthn";

const enc = new TextEncoder();

export function authConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && (process.env.SESSION_SECRET ?? "").length >= 16);
}

/** PASSWORD_LOGIN=off turns password sign-in off (passkeys only). */
export function passwordLoginEnabled(): boolean {
  return (process.env.PASSWORD_LOGIN ?? "on").toLowerCase() !== "off";
}

async function hmacKey(): Promise<CryptoKey> {
  const material = `${process.env.SESSION_SECRET}:${process.env.ADMIN_PASSWORD}`;
  return crypto.subtle.importKey("raw", enc.encode(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function toB64url(buf: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const b of buf instanceof Uint8Array ? buf : new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `payload.exp.sig`, HMAC-signed. Payload must not contain dots. */
export async function sign(payload: string, maxAgeSec: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSec;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(`${payload}.${exp}`));
  return `${payload}.${exp}.${toB64url(sig)}`;
}

/** Returns the payload if the token is genuine and unexpired. */
export async function unsign(token: string | undefined): Promise<string | null> {
  if (!token || !authConfigured()) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [payload, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), fromB64url(sig), enc.encode(`${payload}.${exp}`));
    return ok ? payload : null;
  } catch {
    return null;
  }
}

export function createSession(method: "password" | "passkey"): Promise<string> {
  return sign(`v2-${method}`, SESSION_MAX_AGE);
}

interface CookieSource {
  get(name: string): { value: string } | undefined;
}

export async function verifySession(cookies: CookieSource): Promise<boolean> {
  const token = cookies.get(COOKIE_SECURE)?.value ?? cookies.get(COOKIE_PLAIN)?.value;
  const payload = await unsign(token);
  return payload === "v2-password" || payload === "v2-passkey";
}

export function sessionCookie(value: string, secure: boolean, maxAge = SESSION_MAX_AGE): string {
  return secure
    ? `${COOKIE_SECURE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
    : `${COOKIE_PLAIN}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookies(): string[] {
  return [
    `${COOKIE_SECURE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${COOKIE_PLAIN}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
}

/** Constant-time password check. */
export async function checkPassword(input: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !authConfigured()) return false;
  const key = await hmacKey();
  const [a, b] = await Promise.all([crypto.subtle.sign("HMAC", key, enc.encode(input)), crypto.subtle.sign("HMAC", key, enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ---------- passkeys ---------- */

export interface StoredPasskey {
  name: string;
  rpID: string;
  id: string;
  publicKey: string;
  transports: string[];
}

/**
 * PASSKEYS holds one entry per passkey, comma-separated: name:rpID:credentialId:publicKey:transports
 * (ids and keys base64url, transports joined with +). Public keys are not secrets.
 */
export function getPasskeys(): StoredPasskey[] {
  return (process.env.PASSKEYS ?? "")
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, rpID, id, publicKey, transports = ""] = entry.split(":");
      return { name, rpID, id, publicKey, transports: transports.split("+").filter(Boolean) };
    })
    .filter((p) => p.name && p.rpID && /^[A-Za-z0-9_-]+$/.test(p.id ?? "") && /^[A-Za-z0-9_-]+$/.test(p.publicKey ?? ""));
}

export function encodePasskey(p: StoredPasskey): string {
  const name = p.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 32) || "passkey";
  return [name, p.rpID, p.id, p.publicKey, p.transports.join("+")].join(":");
}

/** Relying party for this request. APP_URL pins it (recommended in production). */
export function relyingParty(req: { headers: Headers; nextUrl: URL }): { rpID: string; origin: string } {
  const pinned = process.env.APP_URL;
  if (pinned) {
    const u = new URL(pinned);
    return { rpID: u.hostname, origin: u.origin };
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const origin = `${proto}://${host}`;
  return { rpID: new URL(origin).hostname, origin };
}
