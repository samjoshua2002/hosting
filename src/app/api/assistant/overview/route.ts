import type { NextRequest } from "next/server";
import { agentModel, aiConfigured, fastModel, listDeployments } from "@/lib/ai";
import { handle, requireAuth } from "@/lib/api";
import { getVms } from "@/lib/config";
import { githubAuth, missingScopes } from "@/lib/github";
import { toolCatalog } from "@/lib/operator";

export const maxDuration = 30;

/** GET /api/assistant/overview: what the Assistant is connected to and what it can do (for the side panel). */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const [gh, deployments] = await Promise.all([githubAuth().catch(() => null), aiConfigured() ? listDeployments().catch(() => []) : Promise.resolve([])]);
  let aiHost = "";
  try {
    aiHost = new URL(process.env.AZURE_OPENAI_ENDPOINT ?? "").host;
  } catch {
    /* not set */
  }
  return Response.json({
    github: gh ? { login: gh.login, scopes: gh.scopes, missing: missingScopes(gh.scopes) } : null,
    ai: { configured: aiConfigured(), host: aiHost, agent: agentModel(), fast: fastModel(), vision: process.env.AZURE_OPENAI_VISION_DEPLOYMENT || "gpt-4o", deployments },
    machines: getVms().map((v) => v.name),
    email: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS),
    unsplash: Boolean(process.env.UNSPLASH_ACCESS_KEY),
    autopilotReady: Boolean(process.env.CRON_SECRET),
    tools: toolCatalog(),
  });
});
