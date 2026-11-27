import { timingSafeEqual } from "node:crypto";
import { after, type NextRequest } from "next/server";
import { handle, HttpError, readJson } from "@/lib/api";
import { continueToken, prepareRun, runSession, type RunRequest } from "@/lib/session-run";
import { SESSION_ID } from "@/lib/sessions";

export const maxDuration = 300;

/**
 * POST /api/ai/continue (server only, x-continue-token): the next time slice of a long Assistant run. Called by the
 * server itself when a slice ran out of time, so long tasks keep going with no browser open. Answers 202 at once
 * and runs in the background (after()).
 */
export const POST = handle(async (req: NextRequest) => {
  const got = Buffer.from(req.headers.get("x-continue-token") ?? "");
  const want = Buffer.from(continueToken());
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "unauthorized");
  const b = await readJson<{ session?: unknown; model?: unknown; review?: unknown; connectorsOff?: unknown }>(req);
  const sessionId = typeof b.session === "string" && SESSION_ID.test(b.session) ? b.session : null;
  if (!sessionId) throw new HttpError(400, "session is required");
  const r: RunRequest = {
    sessionId,
    resume: true,
    model: typeof b.model === "string" && /^[\w.:/-]{1,120}$/.test(b.model) ? b.model : undefined,
    review: b.review === "manual" ? "manual" : "auto",
    connectorsOff: Array.isArray(b.connectorsOff) ? b.connectorsOff.filter((x): x is string => typeof x === "string").slice(0, 60) : undefined,
  };
  const prepared = await prepareRun(r);
  after(() => runSession(r, prepared.doc, prepared.history).catch((e) => console.error("continue failed", e)));
  return new Response(null, { status: 202 });
});
