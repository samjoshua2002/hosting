import { after, type NextRequest } from "next/server";
import { authConfigured, checkPassword, createSession, passwordLoginEnabled, sessionCookie } from "@/lib/auth";
import { handle, HttpError, readJson } from "@/lib/api";
import { sendAlert } from "@/lib/mail";
import { audit, clearLoginFailures, clientIp, loginLocked, recordLoginFailure } from "@/lib/security";

export const POST = handle(async (req: NextRequest) => {
  if (!authConfigured()) throw new HttpError(503, "Login is disabled: set ADMIN_PASSWORD and SESSION_SECRET (16+ chars).");
  if (!passwordLoginEnabled()) throw new HttpError(403, "Password sign-in is turned off. Use your passkey.");
  const ip = clientIp(req);
  const wait = loginLocked(ip);
  if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`);

  const { password } = await readJson<{ password?: string }>(req);
  if (typeof password !== "string" || !(await checkPassword(password))) {
    await new Promise((r) => setTimeout(r, 600));
    const locked = recordLoginFailure(ip);
    audit(req, "login.failed", { method: "password", locked });
    if (locked)
      after(() =>
        sendAlert("Sign-in blocked after repeated failures", `Five wrong passwords in a row from ${ip}. That address is locked out for 15 minutes.`, [
          { tone: "warning", title: `IP ${ip}`, detail: req.headers.get("user-agent") ?? "" },
        ]),
      );
    throw new HttpError(401, "Wrong password");
  }

  clearLoginFailures(ip);
  audit(req, "login.ok", { method: "password" });
  after(() =>
    sendAlert("New sign-in", "Someone signed in to your hosting dashboard with the password.", [
      { tone: "info", title: `From ${ip}`, detail: `${req.headers.get("user-agent") ?? ""}\n${new Date().toUTCString()}` },
    ], "Not you? Change ADMIN_PASSWORD (or SESSION_SECRET) in Vercel and redeploy: every session ends immediately."),
  );
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookie(await createSession("password"), req.nextUrl.protocol === "https:"));
  return res;
});
