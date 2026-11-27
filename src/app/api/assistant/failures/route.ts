import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { deleteFailures, listFailures, setResolved } from "@/lib/failure-log";

export const maxDuration = 30;

/** GET /api/assistant/failures: every place the Assistant failed or got stuck, newest first. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({ items: await listFailures() });
});

/** POST /api/assistant/failures: { ids, resolved } marks entries fixed or open again. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ ids?: unknown; resolved?: unknown }>(req);
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  if (!ids.length) throw new HttpError(400, "ids required");
  return Response.json({ changed: await setResolved(ids, b.resolved !== false) });
});

/** DELETE /api/assistant/failures: { ids } removes entries; { resolved: true } clears every fixed one. */
export const DELETE = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ ids?: unknown; resolved?: unknown }>(req);
  if (b.resolved === true) return Response.json({ removed: await deleteFailures("resolved") });
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  if (!ids.length) throw new HttpError(400, "ids or resolved required");
  return Response.json({ removed: await deleteFailures(ids) });
});
