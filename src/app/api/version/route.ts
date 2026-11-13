import { handle } from "@/lib/api";

/** GET /api/version: the commit this server runs, so open tabs can tell when a newer version is live. */
export const GET = handle(async () => Response.json({ version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev" }));
