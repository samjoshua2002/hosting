import type { NextRequest } from "next/server";
import { ensureAgent, PROJECT_NAME_RE, projectAction, startDeploy, type ProjectAction } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth, vmOrThrow } from "@/lib/api";
import { withVm } from "@/lib/ssh";
import { audit } from "@/lib/security";

export const maxDuration = 60;

const ACTIONS = new Set(["deploy", "start", "stop", "restart", "logs", "remove", "env"]);

/** POST /api/projects/action { vm, name, action } */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ vm?: unknown; name?: unknown; action?: unknown }>(req);
  const vm = vmOrThrow(b.vm);
  const name = typeof b.name === "string" ? b.name : "";
  const action = typeof b.action === "string" ? b.action : "";
  if (!PROJECT_NAME_RE.test(name)) throw new HttpError(400, "invalid project name");
  if (!ACTIONS.has(action)) throw new HttpError(400, "invalid action");

  if (action !== "logs") audit(req, `project.${action}`, { vm: vm.name, name });

  if (action === "env") {
    // KEY='value' lines (written by saveProject with shell quoting) → plain pairs for the UI
    const text = await projectAction(vm, name, "env");
    const env: { key: string; value: string }[] = [];
    for (const line of text.split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      let v = m[2];
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
      env.push({ key: m[1], value: v });
    }
    return Response.json({ env });
  }

  if (action === "deploy") {
    const id = await withVm(vm, async (conn) => {
      await ensureAgent(conn);
      return startDeploy(conn, name);
    });
    return Response.json({ jobId: id });
  }
  const output = await projectAction(vm, name, action as ProjectAction);
  return Response.json({ output });
});
