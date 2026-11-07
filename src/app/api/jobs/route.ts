import type { NextRequest } from "next/server";
import { ensureAgent, newJobId, startJob } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth, vmsOrThrow } from "@/lib/api";
import { mapLimit, withVm } from "@/lib/ssh";
import type { JobStartResult } from "@/lib/types";
import { audit } from "@/lib/security";

export const maxDuration = 60;

/** POST /api/jobs { targets, command, label? } starts a detached background job on each VM. */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const body = await readJson<{ targets?: unknown; command?: unknown; label?: unknown }>(req);
  const vms = vmsOrThrow(body.targets);
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) throw new HttpError(400, "command is empty");
  const label = (typeof body.label === "string" && body.label.trim()) || command.split("\n")[0].slice(0, 80);

  audit(req, "job.start", { targets: vms.map((v) => v.name), command: command.slice(0, 500) });
  const results = await mapLimit(vms, 16, async (vm): Promise<JobStartResult> => {
    try {
      const id = await withVm(vm, async (conn) => {
        await ensureAgent(conn);
        return startJob(
          conn,
          newJobId("job"),
          { label, kind: "command", command: command.slice(0, 2000), startedAt: Math.floor(Date.now() / 1000) },
          command + "\n",
        );
      });
      return { vm: vm.name, id };
    } catch (e) {
      return { vm: vm.name, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return Response.json({ jobs: results });
});
