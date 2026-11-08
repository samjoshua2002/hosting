import type { NextRequest } from "next/server";
import { agentModel, aiConfigured, fastModel, listDeployments } from "@/lib/ai";
import { handle, requireAuth } from "@/lib/api";
import { listLocalModels } from "@/lib/local-models";

export const maxDuration = 60;

/** GET /api/ai/models: Azure deployments, plus the Ollama models on your machines (chat only). */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const local = await listLocalModels(req.nextUrl.searchParams.has("fresh")).catch(() => []);
  if (!aiConfigured()) return Response.json({ configured: false, models: [], local });
  return Response.json({ configured: true, models: await listDeployments(), agent: agentModel(), fast: fastModel(), local });
});
