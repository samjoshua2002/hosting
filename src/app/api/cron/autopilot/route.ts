import type { NextRequest } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { runAutopilot } from "@/lib/autopilot";

export const maxDuration = 300;

/** GET /api/cron/autopilot: one Autopilot pass. Called every 15 minutes by a cron task on the storage machine. */
export const GET = handle(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "unauthorized");
  const s = await runAutopilot();
  return Response.json({ ok: true, lastRun: s.lastRun, summary: s.lastSummary });
});
