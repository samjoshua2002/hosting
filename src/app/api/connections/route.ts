import type { NextRequest } from "next/server";
import { PROJECT_NAME_RE } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { connectProjects, disconnectProjects } from "@/lib/connections";
import { audit } from "@/lib/security";

export const maxDuration = 120;

/** POST /api/connections { from, to, env?, disconnect? }: link an app to a database or service (or unlink). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ from?: unknown; to?: unknown; env?: unknown; disconnect?: unknown }>(req, 2000);
  const from = String(b.from ?? "").toLowerCase();
  const to = String(b.to ?? "").toLowerCase();
  if (!PROJECT_NAME_RE.test(from) || !PROJECT_NAME_RE.test(to)) throw new HttpError(400, "from and to must be project names");
  audit(req, b.disconnect ? "connection.remove" : "connection.add", { from, to });
  try {
    const output = b.disconnect === true ? await disconnectProjects(from, to) : await connectProjects(from, to, typeof b.env === "string" ? b.env : undefined);
    return Response.json({ output });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
