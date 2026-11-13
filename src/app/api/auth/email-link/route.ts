import { after, type NextRequest } from "next/server";
import { authConfigured, createSession, relyingParty, sessionCookie, sign, toB64url, unsign } from "@/lib/auth";
import { handle, HttpError, readJson } from "@/lib/api";
import { alertRecipient, mailConfigured, sendAlert, sendMail } from "@/lib/mail";
import { audit, clientIp } from "@/lib/security";
import { storeGetJson, storePut } from "@/lib/store";

// Sign in from any device with a one-time link sent to the owner's address (ALERT_EMAIL_TO / EMAIL_USER, the one the
// fleet reports go to). Nobody can choose where it's sent; it works once and for 15 minutes. Opening the link shows
// a Continue button (a POST), so mail scanners that open links can't use it up.

const USED = "auth/used-links.json";
const usedHere = new Set<string>();
let lastSent = 0;
const perIp = new Map<string, number>();

const mask = (e: string) => e.replace(/^(.{2}).*(@.*)$/, "$1…$2");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function alreadyUsed(nonce: string): Promise<boolean> {
  if (usedHere.has(nonce)) return true;
  const list = (await storeGetJson<string[]>(USED).catch(() => null)) ?? [];
  return list.includes(nonce);
}
async function markUsed(nonce: string) {
  usedHere.add(nonce);
  const list = (await storeGetJson<string[]>(USED).catch(() => null)) ?? [];
  await storePut(USED, JSON.stringify([...list, nonce].slice(-300))).catch(() => {});
}

/** POST /api/auth/email-link {} sends the link; { token } signs in with it. */
export const POST = handle(async (req: NextRequest) => {
  if (!authConfigured() || !mailConfigured()) throw new HttpError(404, "Email sign-in isn't set up");
  const { token } = await readJson<{ token?: unknown }>(req, 4000);
  const ip = clientIp(req);
  const { origin } = relyingParty(req);

  if (typeof token === "string") {
    const payload = await unsign(token);
    const nonce = payload?.startsWith("link-") ? payload.slice(5) : null;
    if (!nonce) throw new HttpError(401, "This sign-in link has expired. Ask for a new one.");
    if (await alreadyUsed(nonce)) throw new HttpError(401, "This sign-in link was already used. Ask for a new one.");
    await markUsed(nonce);
    audit(req, "login.ok", { method: "email-link" });
    after(() =>
      sendAlert("New sign-in", "Someone signed in to your hosting dashboard with an emailed sign-in link.", [
        { tone: "info", title: `From ${ip}`, detail: `${req.headers.get("user-agent") ?? ""}\n${new Date().toUTCString()}` },
      ], "Not you? Change SESSION_SECRET in Vercel and redeploy: every session ends immediately."),
    );
    const res = Response.json({ ok: true });
    res.headers.append("Set-Cookie", sessionCookie(await createSession("email"), origin.startsWith("https:")));
    return res;
  }

  // send one: at most one a minute overall, and one per 2 minutes per address
  const now = Date.now();
  if (now - lastSent < 60_000 || now - (perIp.get(ip) ?? 0) < 120_000) throw new HttpError(429, "A link was just sent. Check your inbox, or try again in a minute.");
  lastSent = now;
  perIp.set(ip, now);
  const nonce = toB64url(crypto.getRandomValues(new Uint8Array(18)));
  const link = `${origin}/login?link=${encodeURIComponent(await sign(`link-${nonce}`, 15 * 60))}`;
  const to = alertRecipient()!;
  const device = (req.headers.get("user-agent") ?? "a browser").slice(0, 160);
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:28px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="100%" style="max-width:480px;background:#fff;border:1px solid #e4e4e7;border-radius:16px">
<tr><td style="padding:28px 32px">
<p style="margin:0;font-size:13px;font-weight:600;color:#18181b">hosting</p>
<h1 style="margin:16px 0 8px;font-size:22px;color:#09090b">Your sign-in link</h1>
<p style="margin:0 0 20px;color:#3f3f46;font-size:14px;line-height:1.6">Tap the button to sign in to your dashboard. It works once, for the next 15 minutes.</p>
<a href="${esc(link)}" style="display:inline-block;background:#18181b;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px">Sign in to hosting</a>
<p style="margin:22px 0 0;color:#a1a1aa;font-size:12px;line-height:1.5">Asked for from ${esc(ip)} (${esc(device)}). If that wasn't you, ignore this email: nobody can sign in without it.</p>
</td></tr></table></td></tr></table></body></html>`;
  const ok = await sendMail("Your sign-in link for hosting", html, `Sign in to hosting (works once, for 15 minutes):\n${link}\n\nAsked for from ${ip}. If that wasn't you, ignore this email.`);
  if (!ok) throw new HttpError(502, "The email didn't go out. Try again in a minute.");
  audit(req, "login.link-sent", {});
  return Response.json({ sent: true, to: mask(to) });
});
