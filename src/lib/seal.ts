// AES-256-GCM for secrets kept on the storage machine (GitHub token, machine tokens).
// The key comes from SESSION_SECRET plus a purpose label, so one leaked file is useless on its own.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

function key(purpose: string): Buffer {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 16) throw new Error("SESSION_SECRET is not set");
  return createHash("sha256").update(`${s}:${purpose}`).digest();
}

export function seal(text: string, purpose: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(purpose), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function unseal(s: Sealed, purpose: string): string {
  const d = createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
}
