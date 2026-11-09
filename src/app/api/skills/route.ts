import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { installedSkills, removeSkill } from "@/lib/skill-hub";
import { SKILLS } from "@/lib/skills";

export const maxDuration = 30;

async function list() {
  const hub = await installedSkills();
  return {
    builtIn: SKILLS.map((s) => ({ id: s.id, title: s.title })),
    installed: hub.map((h) => ({ slug: h.slug, name: h.name, description: h.description, author: h.author, aiVerdict: h.aiVerdict, installedAt: h.installedAt })),
  };
}

/** GET /api/skills: the Assistant's playbooks (built in) and the ones installed from skills-hub.ai. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json(await list());
});

/** POST /api/skills { remove: slug } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ remove?: unknown }>(req, 1000);
  if (typeof b.remove !== "string") throw new HttpError(400, "remove");
  await removeSkill(b.remove);
  return Response.json(await list());
});
