import type { NextRequest } from "next/server";
import { jobLog } from "@/lib/agent";
import { handle, HttpError, requireAuth, vmOrThrow } from "@/lib/api";

export const maxDuration = 60;

/** GET /api/jobs/log?vm=box1&id=job-xxx */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const p = req.nextUrl.searchParams;
  const vm = vmOrThrow(p.get("vm"));
  const id = p.get("id");
  if (!id) throw new HttpError(400, "missing id");
  return Response.json(await jobLog(vm, id, Number(p.get("bytes")) || 65536));
});
