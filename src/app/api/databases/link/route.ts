import type { NextRequest } from "next/server";
import { probe } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth, vmOrThrow, vmsOrThrow } from "@/lib/api";
import { mapLimit } from "@/lib/ssh";
import { audit } from "@/lib/security";
import { linkTunnel, unlinkTunnel } from "@/lib/tunnels";

export const maxDuration = 120;

/** POST /api/databases/link { db: "box5", targets: ["box1"], link: true|false } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ db?: unknown; targets?: unknown; link?: unknown }>(req);
  const db = vmOrThrow(b.db);
  const targets = vmsOrThrow(b.targets).filter((t) => t.name !== db.name);
  const link = b.link !== false;
  audit(req, link ? "db.link" : "db.unlink", { db: db.name, targets: targets.map((t) => t.name) });

  let ports: number[] = [];
  if (link) {
    const s = await probe(db, 9_999_999_999);
    if (!s.ok || !s.agent) throw new HttpError(503, `${db.name} is not reachable right now`);
    ports = [...new Set(s.agent.projects.filter((p) => p.manifest.category === "database" && p.manifest.port).map((p) => p.manifest.port!))];
    if (!ports.length) throw new HttpError(400, `no databases deployed on ${db.name} yet`);
  }

  const results = await mapLimit(targets, 8, async (t) => {
    try {
      if (!link) {
        await unlinkTunnel(t, db.name);
        return { vm: t.name, ok: true };
      }
      const r = await linkTunnel(t, db, ports);
      return { vm: t.name, ok: true, ...r };
    } catch (e) {
      return { vm: t.name, ok: false, error: (e as Error).message };
    }
  });
  return Response.json({ ports, results });
});
