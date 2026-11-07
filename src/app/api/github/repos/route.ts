import type { NextRequest } from "next/server";
import { handle, requireAuth } from "@/lib/api";
import { listRepos } from "@/lib/github";

export const maxDuration = 30;

/** GET /api/github/repos: the connected account's repos, most recently pushed first. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({ repos: await listRepos() });
});
