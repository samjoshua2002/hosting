import type { NextRequest } from "next/server";
import { handle, HttpError, readJson, requireAuth, vmsOrThrow } from "@/lib/api";
import { mapLimit, run, withVm } from "@/lib/ssh";
import { audit } from "@/lib/security";
import type { ExecResult } from "@/lib/types";

export const maxDuration = 300;

const MAX_TIMEOUT_SEC = 280; // stays under maxDuration; longer work should run as a background job

/**
 * POST /api/exec { targets: string[], command: string, timeoutSec?: number }
 * Streams one JSON line per VM (NDJSON) as each finishes.
 */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const body = await readJson<{ targets?: unknown; command?: unknown; timeoutSec?: unknown }>(req);
  const vms = vmsOrThrow(body.targets);
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) throw new HttpError(400, "command is empty");
  if (command.length > 20_000) throw new HttpError(400, "command is too long");
  const timeoutSec = Math.min(Math.max(Number(body.timeoutSec) || 120, 1), MAX_TIMEOUT_SEC);
  audit(req, "exec", { targets: vms.map((v) => v.name), command: command.slice(0, 500) });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await mapLimit(vms, 16, async (vm) => {
        const t0 = Date.now();
        let result: ExecResult;
        try {
          const out = await withVm(vm, (conn) => run(conn, command, { timeoutMs: timeoutSec * 1000 }));
          result = {
            vm: vm.name,
            code: out.code,
            stdout: out.stdout,
            stderr: out.stderr,
            ms: Date.now() - t0,
            truncated: out.truncated,
            error: out.timedOut ? `Timed out after ${timeoutSec}s (use "Run in background" for long tasks)` : undefined,
          };
        } catch (e) {
          result = {
            vm: vm.name,
            code: null,
            stdout: "",
            stderr: "",
            ms: Date.now() - t0,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        controller.enqueue(encoder.encode(JSON.stringify(result) + "\n"));
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
});
