import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { audit } from "@/lib/security";
import { createService } from "@/lib/services";

export const maxDuration = 120;

/** POST /api/services { template, name?, vm?, connectTo? }: create a service from the catalog and deploy it. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ template?: unknown; name?: unknown; vm?: unknown; connectTo?: unknown }>(req, 4000);
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (!s(b.template)) throw new HttpError(400, "template is required");
  try {
    const r = await createService({ template: s(b.template)!, name: s(b.name), vm: s(b.vm), connectTo: s(b.connectTo) });
    audit(req, "service.create", { template: b.template, name: r.name, vm: r.vm });
    return Response.json(r);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
