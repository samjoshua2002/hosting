import type { NextRequest } from "next/server";
import { handle, HttpError } from "@/lib/api";

/**
 * GET /api/cron/sign-in-config: how this deployment signs people in (the registered passkeys' public keys and
 * whether password sign-in is on), so a second deployment (the Render backend) can be set up to match.
 * Public keys aren't secrets, but it still needs CRON_SECRET.
 */
export const GET = handle(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "unauthorized");
  return Response.json({ PASSKEYS: process.env.PASSKEYS ?? "", PASSWORD_LOGIN: process.env.PASSWORD_LOGIN ?? "" });
});
