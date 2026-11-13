import type { NextRequest } from "next/server";
import { authConfigured, relyingParty, sign, toB64url } from "@/lib/auth";
import { handle, HttpError } from "@/lib/api";
import { authorizeUrl, zohoConfigured } from "@/lib/zoho";

const STATE_COOKIE = "hosting_zoho_state";

/** GET /api/auth/zoho/start: off to Zoho's sign-in page, with a one-time state tied to this browser. */
export const GET = handle(async (req: NextRequest) => {
  if (!authConfigured() || !zohoConfigured()) throw new HttpError(404, "Zoho sign-in isn't set up");
  const { origin } = relyingParty(req);
  const nonce = toB64url(crypto.getRandomValues(new Uint8Array(24)));
  const secure = origin.startsWith("https:");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl(origin, nonce),
      "Set-Cookie": `${STATE_COOKIE}=${await sign(nonce, 600)}; Path=/api/auth/zoho; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
      "Cache-Control": "no-store",
    },
  });
});
