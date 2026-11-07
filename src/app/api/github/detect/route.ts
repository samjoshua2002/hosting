import type { NextRequest } from "next/server";
import { handle, HttpError, requireAuth } from "@/lib/api";
import { detectFramework, getRepo, REPO_RE } from "@/lib/github";

export const maxDuration = 30;

/** GET /api/github/detect?repo=owner/name[&branch=]: repo facts plus a guessed build/start setup. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const repo = req.nextUrl.searchParams.get("repo") ?? "";
  if (!REPO_RE.test(repo)) throw new HttpError(400, "repo must look like owner/name");
  const info = await getRepo(repo);
  const branch = req.nextUrl.searchParams.get("branch") || info.defaultBranch;
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) throw new HttpError(400, "bad branch");
  return Response.json({ repo: info, branch, detected: await detectFramework(info.fullName, branch) });
});
