import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { getInstructions, MAX_INSTRUCTIONS, setInstructions } from "@/lib/instructions";

export const maxDuration = 30;

/** GET /api/assistant/instructions: the user's standing instructions for the Assistant. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({ text: await getInstructions(), max: MAX_INSTRUCTIONS });
});

/** POST /api/assistant/instructions { text } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ text?: unknown }>(req, 20_000);
  if (typeof b.text !== "string") throw new HttpError(400, "text");
  return Response.json({ text: await setInstructions(b.text), max: MAX_INSTRUCTIONS });
});
