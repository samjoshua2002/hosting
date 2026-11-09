import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth";

// Reachable without a session: the login page and the endpoints that perform login.
// /api/cron/* authenticates with CRON_SECRET inside the handler; /go/* forwards public links to anyone and private ones only when signed in; /api/github/webhook checks GitHub's HMAC signature.
const PUBLIC = new Set(["/login", "/api/auth/login", "/api/auth/passkey/options", "/api/auth/passkey/verify", "/api/auth/methods", "/api/banner", "/api/github/webhook"]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.has(pathname) || pathname.startsWith("/api/cron/") || pathname.startsWith("/go/")) return NextResponse.next();

  if (await verifySession(req.cookies)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
