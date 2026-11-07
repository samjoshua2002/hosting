import type { NextRequest } from "next/server";
import { probe } from "@/lib/agent";
import { aiConfigured, chat, fastModel } from "@/lib/ai";
import { handle, HttpError } from "@/lib/api";
import { getVms } from "@/lib/config";
import { findProblems } from "@/lib/health";
import { sendAlert } from "@/lib/mail";
import { mapLimit } from "@/lib/ssh";

export const maxDuration = 120;

/**
 * GET /api/cron/health: scheduled health check (vercel.json cron). Authenticated by CRON_SECRET,
 * which Vercel sends as "Authorization: Bearer <secret>". Emails only when something is wrong
 * (add ?always=1 for a daily summary even when healthy).
 */
export const GET = handle(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "unauthorized");

  const statuses = await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999));
  const problems = findProblems(statuses);
  const always = req.nextUrl.searchParams.get("always") === "1";
  if (!problems.length && !always) return Response.json({ ok: true, problems: 0, emailed: false });

  let advice: string | undefined;
  if (problems.length && aiConfigured()) {
    try {
      const res = await chat({
        model: fastModel(),
        maxTokens: 500,
        messages: [
          {
            role: "system",
            content:
              "You are an SRE. Given these alerts from InstaBox VMs (unreachable usually means paused/cooldown), write 2-4 short lines: what likely happened and what to do first. Plain text.",
          },
          { role: "user", content: JSON.stringify(problems) },
        ],
      });
      advice = res.message.content ?? undefined;
    } catch {
      /* the alert matters more than the advice */
    }
  }

  const online = statuses.filter((s) => s.ok).length;
  const emailed = await sendAlert(
    problems.length ? `${problems.length} issue${problems.length > 1 ? "s" : ""} in your fleet` : "Daily fleet summary: all healthy",
    `${online} of ${statuses.length} machines answered the scheduled health check.`,
    problems.length ? problems : [{ tone: "good", title: "No problems found" }],
    advice ? `AI first look:\n${advice}` : undefined,
  );
  return Response.json({ ok: true, problems: problems.length, emailed });
});
