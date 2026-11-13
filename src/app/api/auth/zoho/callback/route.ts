import { after, type NextRequest } from "next/server";
import { authConfigured, createSession, relyingParty, sessionCookie, unsign } from "@/lib/auth";
import { handle } from "@/lib/api";
import { sendAlert } from "@/lib/mail";
import { audit, clientIp } from "@/lib/security";
import { allowedEmails, trustedAccountsServer, zohoConfigured, zohoEmail } from "@/lib/zoho";

const STATE_COOKIE = "hosting_zoho_state";
const clearState = (secure: boolean) => `${STATE_COOKIE}=; Path=/api/auth/zoho; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

/** GET /api/auth/zoho/callback: Zoho sends the person back here; allowed addresses get a session. */
export const GET = handle(async (req: NextRequest) => {
  const { origin } = relyingParty(req);
  const secure = origin.startsWith("https:");
  const back = (error?: string) => {
    const h = new Headers({ Location: error ? `${origin}/login?error=${encodeURIComponent(error)}` : `${origin}/`, "Cache-Control": "no-store" });
    h.append("Set-Cookie", clearState(secure));
    return h;
  };
  if (!authConfigured() || !zohoConfigured()) return new Response(null, { status: 302, headers: back("Zoho sign-in isn't set up") });

  const q = req.nextUrl.searchParams;
  if (q.get("error")) return new Response(null, { status: 302, headers: back(q.get("error") === "access_denied" ? "Zoho sign-in was cancelled" : `Zoho: ${q.get("error")}`) });
  const expected = await unsign(req.cookies.get(STATE_COOKIE)?.value);
  if (!expected || q.get("state") !== expected) return new Response(null, { status: 302, headers: back("That sign-in link expired. Try again.") });
  const code = q.get("code");
  if (!code) return new Response(null, { status: 302, headers: back("Zoho didn't send a sign-in code") });

  const ip = clientIp(req);
  let who: { email: string; name?: string };
  try {
    who = await zohoEmail(code, origin, trustedAccountsServer(q.get("accounts-server")));
  } catch (e) {
    audit(req, "login.failed", { method: "zoho", reason: (e as Error).message });
    return new Response(null, { status: 302, headers: back((e as Error).message) });
  }
  if (!allowedEmails().includes(who.email)) {
    audit(req, "login.failed", { method: "zoho", email: who.email });
    after(() =>
      sendAlert("Sign-in refused", `Someone signed in with Zoho as ${who.email}, which isn't allowed into the dashboard.`, [
        { tone: "warning", title: `From ${ip}`, detail: req.headers.get("user-agent") ?? "" },
      ]),
    );
    return new Response(null, { status: 302, headers: back(`${who.email} isn't allowed to sign in here`) });
  }

  audit(req, "login.ok", { method: "zoho", email: who.email });
  after(() =>
    sendAlert("New sign-in", `${who.name ?? who.email} signed in to your hosting dashboard with Zoho.`, [
      { tone: "info", title: `${who.email} from ${ip}`, detail: `${req.headers.get("user-agent") ?? ""}\n${new Date().toUTCString()}` },
    ], "Not you? Remove the address from ZOHO_ALLOWED_EMAILS, or change SESSION_SECRET in Vercel and redeploy: every session ends immediately."),
  );
  const h = back();
  h.append("Set-Cookie", sessionCookie(await createSession("zoho"), secure));
  return new Response(null, { status: 302, headers: h });
});
