import type { NextRequest } from "next/server";
import { killJob } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth, vmOrThrow } from "@/lib/api";
import { audit } from "@/lib/security";

export const maxDuration = 60;

/** POST /api/jobs/kill { vm, id } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const body = await readJson<{ vm?: unknown; id?: unknown }>(req);
  const vm = vmOrThrow(body.vm);
  if (typeof body.id !== "string") throw new HttpError(400, "missing id");
  audit(req, "job.kill", { vm: vm.name, id: body.id });
  await killJob(vm, body.id);
  return Response.json({ ok: true });
});
