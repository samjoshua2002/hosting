import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { addMachine, removeMachine } from "@/lib/machines";
import { audit } from "@/lib/security";

export const maxDuration = 180;

/** POST /api/machines { ssh, name? } adds a machine (and sets it up); { remove: name } removes an added one. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ ssh?: unknown; name?: unknown; remove?: unknown }>(req, 4000);
  try {
    if (typeof b.remove === "string") {
      await removeMachine(b.remove);
      audit(req, "machine.remove", { name: b.remove });
      return Response.json({ ok: true });
    }
    if (typeof b.ssh !== "string") throw new Error("paste the SSH command, token or user@host");
    const r = await addMachine(b.ssh, typeof b.name === "string" && b.name ? b.name : undefined);
    audit(req, "machine.add", { name: r.name });
    return Response.json(r);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
