import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { connectGithub, disconnectGithub, githubAuth, missingScopes } from "@/lib/github";
import { audit } from "@/lib/security";

export const maxDuration = 30;

/** GET /api/github: who is connected (never the token). */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const a = await githubAuth(req.nextUrl.searchParams.has("fresh"));
  return Response.json(a ? { connected: true, login: a.login, source: a.source, scopes: a.scopes, missing: missingScopes(a.scopes) } : { connected: false });
});

/** POST /api/github { token } connects; { disconnect: true } forgets the saved token. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ token?: unknown; disconnect?: unknown }>(req, 4000);
  if (b.disconnect === true) {
    if (process.env.GITHUB_TOKEN) throw new HttpError(400, "Connected through the GITHUB_TOKEN env var; remove it there");
    await disconnectGithub();
    audit(req, "github.disconnect", {});
    return Response.json({ connected: false });
  }
  if (typeof b.token !== "string") throw new HttpError(400, "token is required");
  const a = await connectGithub(b.token).catch((e: Error) => {
    throw new HttpError(400, e.message);
  });
  audit(req, "github.connect", { login: a.login, scopes: a.scopes });
  return Response.json({ connected: true, login: a.login, source: a.source, scopes: a.scopes, missing: missingScopes(a.scopes) });
});
