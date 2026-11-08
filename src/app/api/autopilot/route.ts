import { after, type NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { getAutopilot, runAutopilot, setAutopilot } from "@/lib/autopilot";
import { audit } from "@/lib/security";

export const maxDuration = 300;

/** GET /api/autopilot: on/off and the last pass. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({ ...(await getAutopilot()), canEnable: Boolean(process.env.CRON_SECRET) });
});

/** POST /api/autopilot { enabled } switches it; { run: true } does a pass now (in the background). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ enabled?: unknown; run?: unknown }>(req, 1000);
  if (typeof b.enabled === "boolean") {
    const base = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : req.nextUrl.origin);
    const s = await setAutopilot(b.enabled, base).catch((e: Error) => {
      throw new HttpError(400, e.message);
    });
    audit(req, b.enabled ? "autopilot.on" : "autopilot.off", {});
    return Response.json(s);
  }
  if (b.run === true) {
    after(() => runAutopilot({ force: true }).catch((e) => console.error("autopilot", e)));
    return Response.json({ started: true }, { status: 202 });
  }
  throw new HttpError(400, "enabled or run");
});
