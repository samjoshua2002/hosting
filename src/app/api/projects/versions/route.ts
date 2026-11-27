import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { PROJECT_NAME_RE } from "@/lib/agent";
import { audit } from "@/lib/security";
import { continueFrom, liveRef, listVersions, saveVersion, switchVersion } from "@/lib/versions";

export const maxDuration = 60;

/** GET /api/projects/versions?project=<name>&repo=<owner/name>: the saved versions and which one is live. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const u = new URL(req.url);
  const project = u.searchParams.get("project") ?? "";
  const repo = u.searchParams.get("repo") ?? "";
  if (!PROJECT_NAME_RE.test(project)) throw new HttpError(400, "invalid project name");
  const [versions, live] = await Promise.all([listVersions(repo), liveRef(project)]);
  return Response.json({ versions, live });
});

/**
 * POST /api/projects/versions
 * { action: "save", repo, name, note? }        tag the current code as the next version
 * { action: "switch", project, version }        make a version live ("latest" follows the branch again)
 * { action: "continue", repo, version }         make an old version the current code (new commit)
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ action?: unknown; project?: unknown; repo?: unknown; version?: unknown; name?: unknown; note?: unknown }>(req);
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const action = s(b.action);
  if (action === "save") {
    const v = await saveVersion(s(b.repo), { name: s(b.name), note: s(b.note) });
    audit(req, "project.version.save", { repo: s(b.repo), tag: v.tag });
    return Response.json({ version: v });
  }
  if (action === "switch") {
    if (!PROJECT_NAME_RE.test(s(b.project))) throw new HttpError(400, "invalid project name");
    const r = await switchVersion(s(b.project), s(b.version) || "latest");
    audit(req, "project.version.switch", { project: s(b.project), live: r.live });
    return Response.json(r);
  }
  if (action === "continue") {
    const r = await continueFrom(s(b.repo), s(b.version));
    audit(req, "project.version.continue", { repo: s(b.repo), version: s(b.version) });
    return Response.json(r);
  }
  throw new HttpError(400, "action must be save, switch or continue");
});
