import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { installedSkills, installSkill, removeSkill, saveCustomSkill, searchHub } from "@/lib/skill-hub";
import { SKILLS } from "@/lib/skills";

export const maxDuration = 30;

async function list() {
  const hub = await installedSkills();
  return {
    builtIn: SKILLS.map((s) => ({ id: s.id, title: s.title })),
    installed: hub.map((h) => ({ slug: h.slug, name: h.name, description: h.description, author: h.author, aiVerdict: h.aiVerdict, installedAt: h.installedAt })),
  };
}

/** GET /api/skills: the Assistant's playbooks (built in) and the ones installed from skills-hub.ai or custom. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const q = req.nextUrl.searchParams.get("q");
  // ?q=… searches skills-hub.ai (Discover)
  if (q !== null) return Response.json({ results: await searchHub(q || "deploy", 18).catch(() => []) });
  return Response.json(await list());
});

/** POST /api/skills { remove: slug } | { install: slug } | { custom: { name, slug, description, content } } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{
    remove?: unknown;
    install?: unknown;
    custom?: { name?: unknown; slug?: unknown; description?: unknown; content?: unknown; author?: unknown };
    content?: unknown;
    name?: unknown;
  }>(req, 100_000);
  try {
    if (typeof b.remove === "string") {
      await removeSkill(b.remove);
    } else if (typeof b.install === "string") {
      await installSkill(b.install);
    } else if (b.custom && typeof b.custom === "object" && typeof b.custom.content === "string") {
      await saveCustomSkill({
        name: typeof b.custom.name === "string" ? b.custom.name : undefined,
        slug: typeof b.custom.slug === "string" ? b.custom.slug : undefined,
        description: typeof b.custom.description === "string" ? b.custom.description : undefined,
        content: b.custom.content,
        author: typeof b.custom.author === "string" ? b.custom.author : undefined,
      });
    } else if (typeof b.content === "string" && b.content.trim()) {
      await saveCustomSkill({
        name: typeof b.name === "string" ? b.name : undefined,
        content: b.content,
      });
    } else {
      throw new HttpError(400, "remove, install, or custom skill required");
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
  return Response.json(await list());
});
