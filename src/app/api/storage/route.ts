import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { storeStatus, switchStore } from "@/lib/store-location";

export const maxDuration = 60;

/** GET /api/storage: which machine holds the dashboard's data, whether it's up, and where the latest copy is. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json(await storeStatus());
});

/** POST /api/storage { switchTo }: the storage machine is resting and the user chose to carry on from the copy. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ switchTo?: unknown }>(req, 1000);
  if (typeof b.switchTo !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(b.switchTo)) throw new HttpError(400, "switchTo: a machine name");
  try {
    return Response.json(await switchStore(b.switchTo));
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
});
