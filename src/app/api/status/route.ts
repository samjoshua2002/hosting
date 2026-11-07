import type { NextRequest } from "next/server";
import { probe } from "@/lib/agent";
import { getVms } from "@/lib/config";
import { handle, requireAuth, vmOrThrow } from "@/lib/api";
import { mapLimit } from "@/lib/ssh";

export const maxDuration = 60;

/** GET /api/status?vm=box1 for one VM (the UI uses this so slow VMs don't block fast ones), or all VMs. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const name = req.nextUrl.searchParams.get("vm");
  const since = Number(req.nextUrl.searchParams.get("since")) || 0;
  const targets = name ? [vmOrThrow(name)] : getVms();
  const results = await mapLimit(targets, 16, (vm) => probe(vm, since));
  return Response.json({ vms: results });
});
