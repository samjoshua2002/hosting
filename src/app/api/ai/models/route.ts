import type { NextRequest } from "next/server";
import { agentModel, aiConfigured, fastModel, listDeployments } from "@/lib/ai";
import { handle, requireAuth } from "@/lib/api";

/** GET /api/ai/models: deployments found on the Azure OpenAI resource. */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  if (!aiConfigured()) return Response.json({ configured: false, models: [] });
  return Response.json({ configured: true, models: await listDeployments(), agent: agentModel(), fast: fastModel() });
});
