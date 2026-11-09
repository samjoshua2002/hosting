import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { connectMcp, connectorStates, connectToken, disconnect } from "@/lib/connectors";
import { audit } from "@/lib/security";

export const maxDuration = 60;

/** GET /api/connectors: every connector's state (never tokens). */
export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  return Response.json({ states: await connectorStates() });
});

/** POST /api/connectors { connect: {id, token} } | { mcp: id } | { disconnect: id } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ connect?: { id?: unknown; token?: unknown }; mcp?: unknown; disconnect?: unknown }>(req, 10_000);
  try {
    if (b.connect && typeof b.connect.id === "string" && typeof b.connect.token === "string") {
      await connectToken(b.connect.id, b.connect.token);
      audit(req, "connector.connect", { id: b.connect.id });
    } else if (typeof b.mcp === "string") {
      await connectMcp(b.mcp);
      audit(req, "connector.connect", { id: b.mcp });
    } else if (typeof b.disconnect === "string") {
      await disconnect(b.disconnect);
      audit(req, "connector.disconnect", { id: b.disconnect });
    } else throw new HttpError(400, "connect, mcp or disconnect");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
  return Response.json({ states: await connectorStates() });
});
