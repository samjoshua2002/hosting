// Sign in with Zoho (OAuth 2.0 / OpenID Connect, authorization-code flow). Works from any device: Zoho checks the
// person, and only the addresses in ZOHO_ALLOWED_EMAILS get a dashboard session.
//
// Setup (api-console.zoho.com → Add Client → Server-based Applications):
//   Homepage URL:            <APP_URL>
//   Authorized Redirect URI: <APP_URL>/api/auth/zoho/callback
// Then set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_ALLOWED_EMAILS (comma-separated) on the server.

/** Zoho's sign-in servers per data centre; a callback may only name one of these. */
const ZOHO_ACCOUNTS = /^https:\/\/accounts\.zoho\.(com|in|eu|com\.au|jp|ca|sa|uk|com\.cn)$/;

export function zohoConfigured(): boolean {
  return Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && allowedEmails().length);
}

export function allowedEmails(): string[] {
  return (process.env.ZOHO_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/** The accounts server to start at (ZOHO_ACCOUNTS_URL, e.g. https://accounts.zoho.in); .com redirects to the right one. */
export function zohoAccountsUrl(): string {
  const u = (process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com").replace(/\/$/, "");
  return ZOHO_ACCOUNTS.test(u) ? u : "https://accounts.zoho.com";
}

/** The accounts server Zoho named in the callback (the user's data centre), if it is a real Zoho one. */
export function trustedAccountsServer(v: string | null): string {
  const u = (v ?? "").replace(/\/$/, "");
  return ZOHO_ACCOUNTS.test(u) ? u : zohoAccountsUrl();
}

export function redirectUri(origin: string): string {
  return `${origin}/api/auth/zoho/callback`;
}

export function authorizeUrl(origin: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ZOHO_CLIENT_ID!,
    scope: "openid email profile",
    redirect_uri: redirectUri(origin),
    access_type: "online",
    prompt: "select_account",
    state,
  });
  return `${zohoAccountsUrl()}/oauth/v2/auth?${q}`;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Exchange the code for tokens (server to server, over TLS, with the client secret) and return the signed-in
 * person's email, checked as verified. Throws with a readable message on anything unexpected.
 */
export async function zohoEmail(code: string, origin: string, accountsServer: string): Promise<{ email: string; name?: string }> {
  const res = await fetch(`${accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      redirect_uri: redirectUri(origin),
      code,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error?: string };
  if (!res.ok || tok.error || !tok.access_token) throw new Error(`Zoho didn't accept the sign-in (${tok.error ?? res.status})`);

  // the id_token comes straight from Zoho's token endpoint (TLS, our secret), so its claims can be read as-is
  const claims = tok.id_token ? decodeJwtPayload(tok.id_token) : null;
  let email = typeof claims?.email === "string" ? claims.email : "";
  let verified = claims?.email_verified;
  let name = typeof claims?.name === "string" ? claims.name : undefined;
  if (claims && claims.aud !== undefined && claims.aud !== process.env.ZOHO_CLIENT_ID) throw new Error("Zoho sign-in was meant for another app");

  if (!email) {
    const info = await fetch(`${accountsServer}/oauth/v2/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(15_000) });
    const u = (await info.json().catch(() => ({}))) as { email?: string; email_verified?: boolean | string; name?: string };
    email = u.email ?? "";
    verified = u.email_verified;
    name ??= u.name;
  }
  if (!email) throw new Error("Zoho didn't share an email address");
  if (verified === false || verified === "false") throw new Error("That Zoho email address isn't verified yet");
  return { email: email.toLowerCase(), name };
}
