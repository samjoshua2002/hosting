import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { forget, listMemory, remember } from "@/lib/memory";

export const maxDuration = 30;

/** GET /api/memory: what the Assistant remembers. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({ memory: await listMemory() });
});

/** POST /api/memory { add } or { remove: id } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ add?: unknown; remove?: unknown }>(req, 4000);
  if (typeof b.remove === "string") await forget(b.remove);
  else if (typeof b.add === "string") await remember(b.add);
  else throw new HttpError(400, "add or remove");
  return Response.json({ memory: await listMemory() });
});
