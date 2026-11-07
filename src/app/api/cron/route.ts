import type { NextRequest } from "next/server";
import { cronAction } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth, vmsOrThrow } from "@/lib/api";
import { isDestructive } from "@/lib/safety";
import { audit } from "@/lib/security";
import { mapLimit } from "@/lib/ssh";

export const maxDuration = 150;

/** POST /api/cron { action: add|remove|run|logs, vms: [...], name, schedule?, command? } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ action?: unknown; vms?: unknown; name?: unknown; schedule?: unknown; command?: unknown }>(req);
  const action = String(b.action);
  if (!["add", "remove", "run", "logs"].includes(action)) throw new HttpError(400, "bad action");
  const vms = vmsOrThrow(b.vms);
  const name = String(b.name ?? "");
  const command = typeof b.command === "string" ? b.command.trim() : "";
  if (action === "add" && !command) throw new HttpError(400, "command is empty");
  if (action === "add" && isDestructive(command)) throw new HttpError(400, "destructive commands can't be scheduled from here; use Run or the Assistant");
  if (action !== "logs") audit(req, `cron.${action}`, { vms: vms.map((v) => v.name), name, schedule: b.schedule, command: command.slice(0, 300) });
  const results = await mapLimit(vms, 8, async (vm) => {
    try {
      return { vm: vm.name, ok: true, output: await cronAction(vm, action as "add" | "remove" | "run" | "logs", name, String(b.schedule ?? ""), command) };
    } catch (e) {
      return { vm: vm.name, ok: false, output: (e as Error).message };
    }
  });
  return Response.json({ results });
});
