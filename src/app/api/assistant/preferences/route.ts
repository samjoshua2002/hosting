import type { NextRequest } from "next/server";
import { handle, readJson, requireAuth } from "@/lib/api";
import { getPreferences, setPreferences, type Preferences } from "@/lib/preferences";

export const maxDuration = 30;

/** GET /api/assistant/preferences */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json(await getPreferences());
});

/** POST /api/assistant/preferences { …partial } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json(await setPreferences(await readJson<Partial<Preferences>>(req, 4000)));
});
