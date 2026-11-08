import type { NextRequest } from "next/server";
import { listManifests, PROJECT_NAME_RE } from "@/lib/agent";
import { handle, HttpError, readJson, requireAuth } from "@/lib/api";
import { getVms } from "@/lib/config";
import { run, withVm } from "@/lib/ssh";

export const maxDuration = 150;

/** POST /api/services/try { name, prompt }: ask an Ollama service a question (on its machine, over SSH). */
export const POST = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const b = await readJson<{ name?: unknown; prompt?: unknown }>(req, 20_000);
  const name = String(b.name ?? "");
  const prompt = String(b.prompt ?? "").slice(0, 8000);
  if (!PROJECT_NAME_RE.test(name) || !prompt.trim()) throw new HttpError(400, "name and prompt are required");
  for (const vm of getVms()) {
    const found = await withVm(vm, async (c) => {
      const m = (await listManifests(c)).find((x) => x.name === name);
      if (!m) return null;
      if (!/ollama/.test(`${m.start} ${m.build}`) || !m.port) throw new HttpError(400, `${name} isn't an Ollama service`);
      // the model from its settings, else the first one it has
      const env = await run(c, `grep -E '^MODEL=' "$HOME/.hosting/projects/${name}.env" | cut -d= -f2- | tr -d "'\\""`, { timeoutMs: 10_000 });
      let model = env.stdout.trim();
      if (!model) {
        const tags = await run(c, `curl -s --max-time 10 http://127.0.0.1:${m.port}/api/tags`, { timeoutMs: 15_000 });
        model = (JSON.parse(tags.stdout || "{}") as { models?: { name: string }[] }).models?.[0]?.name ?? "";
      }
      if (!model) throw new HttpError(400, "no model pulled yet");
      const t0 = Date.now();
      const r = await run(c, `curl -s --max-time 130 http://127.0.0.1:${m.port}/api/generate --data-binary @-`, {
        stdin: JSON.stringify({ model, prompt, stream: false }),
        timeoutMs: 140_000,
        maxBytes: 512 * 1024,
      });
      let answer = "";
      try {
        const j = JSON.parse(r.stdout) as { response?: string; error?: string };
        if (j.error) throw new HttpError(502, j.error);
        answer = j.response ?? "";
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, `no answer (${(r.stderr || r.stdout).slice(0, 160) || "timed out"})`);
      }
      return { model, answer, ms: Date.now() - t0, vm: vm.name };
    }).catch((e) => {
      if (e instanceof HttpError) throw e;
      return null;
    });
    if (found) return Response.json(found);
  }
  throw new HttpError(404, `no service called ${name}`);
});
