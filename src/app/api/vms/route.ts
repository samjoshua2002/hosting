import type { NextRequest } from "next/server";
import { getConfig, toInfo } from "@/lib/config";
import { handle, requireAuth } from "@/lib/api";
import { AGENT_VERSION } from "@/lib/agent-script.generated";

export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const { vms, errors } = getConfig();
  return Response.json({
    vms: vms.map(toInfo),
    errors,
    agentVersion: AGENT_VERSION,
    hostKeyPinned: vms.filter((v) => v.kind === "instabox").every((v) => v.hostKeys.length > 0),
  });
});
