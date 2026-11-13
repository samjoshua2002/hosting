import type { NextRequest } from "next/server";
import { probe } from "@/lib/agent";
import { handle, HttpError } from "@/lib/api";
import { getVms } from "@/lib/config";
import { findProblems } from "@/lib/health";
import { logEvents, maybeSendReport } from "@/lib/report";
import { mapLimit } from "@/lib/ssh";

export const maxDuration = 120;

/**
 * GET /api/cron/health: scheduled health check (vercel.json cron). Authenticated by CRON_SECRET,
 * which Vercel sends as "Authorization: Bearer <secret>". Feeds the fleet report (see lib/report.ts).
 */
export const GET = handle(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "unauthorized");

  const statuses = await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999));
  const problems = findProblems(statuses);
  // no separate email: problems go into the fleet report, which is sent here too when one is due
  // (a safety net for when Autopilot is off; ?always=1 sends it now)
  await logEvents(problems.map((p) => ({ kind: p.tone === "good" ? ("fixed" as const) : ("problem" as const), text: p.detail ? `${p.title}: ${p.detail}` : p.title })));
  const r = await maybeSendReport({ fleet: statuses, force: req.nextUrl.searchParams.get("always") === "1" });
  return Response.json({ ok: true, problems: problems.length, emailed: r.sent, reason: r.reason });
});
