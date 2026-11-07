import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { requestStop, SESSION_ID } from "@/lib/sessions";

export const maxDuration = 30;

/** POST /api/ai/stop { session }: the run stops at its next step (it may be running without this tab). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ session?: unknown }>(req, 2000);
  if (typeof b.session !== "string" || !SESSION_ID.test(b.session)) throw new HttpError(400, "bad session");
  await requestStop(b.session);
  return Response.json({ ok: true });
});
