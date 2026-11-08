// Models served by Ollama on your own machines. They run on CPU, so the Assistant uses them in chat mode:
// a short prompt with a fleet snapshot, no tools. Reached over SSH, so their links can stay private.
import { listManifests } from "./agent";
import type { ChatMessage } from "./ai";
import { getVms, type VmConfig } from "./config";
import { mapLimit, run, withVm } from "./ssh";

export interface LocalModel {
  /** ollama/<service>/<model> */
  id: string;
  model: string;
  service: string;
  vm: string;
  sizeGb: number;
}

let cache: { at: number; list: LocalModel[]; where: Map<string, { vm: VmConfig; port: number }> } | null = null;

export async function listLocalModels(fresh = false): Promise<LocalModel[]> {
  if (!fresh && cache && Date.now() - cache.at < 2 * 60_000) return cache.list;
  const where = new Map<string, { vm: VmConfig; port: number }>();
  const found = await mapLimit(getVms(), 12, async (vm) => {
    try {
      return await withVm(vm, async (c) => {
        const out: LocalModel[] = [];
        for (const m of (await listManifests(c)).filter((x) => /\bollama\b/.test(`${x.start} ${x.build}`) && x.port)) {
          where.set(m.name, { vm, port: m.port! });
          const r = await run(c, `curl -s --max-time 8 http://127.0.0.1:${m.port}/api/tags`, { timeoutMs: 12_000 });
          try {
            for (const t of (JSON.parse(r.stdout) as { models?: { name: string; size: number }[] }).models ?? [])
              out.push({ id: `ollama/${m.name}/${t.name}`, model: t.name, service: m.name, vm: vm.name, sizeGb: +(t.size / 1e9).toFixed(1) });
          } catch {
            /* not answering right now */
          }
        }
        return out;
      });
    } catch {
      return [];
    }
  });
  cache = { at: Date.now(), list: found.flat(), where };
  return cache.list;
}

export function isLocal(model?: string): boolean {
  return Boolean(model?.startsWith("ollama/"));
}

/** One reply from a local model (no tools). */
export async function chatLocal(id: string, messages: ChatMessage[], timeoutMs = 240_000): Promise<string> {
  const [, service, ...rest] = id.split("/");
  const model = rest.join("/");
  if (!cache?.where.has(service)) await listLocalModels(true);
  const at = cache?.where.get(service);
  if (!at) throw new Error(`no Ollama service called ${service} is reachable`);
  const body = JSON.stringify({
    model,
    stream: false,
    options: { num_ctx: 8192, temperature: 0.4 },
    messages: messages
      .filter((m) => m.role === "system" || m.role === "user" || (m.role === "assistant" && typeof m.content === "string" && m.content))
      .map((m) => ({ role: m.role, content: String(m.content ?? "") })),
  });
  return withVm(at.vm, async (c) => {
    const r = await run(c, `curl -s --max-time ${Math.floor(timeoutMs / 1000) - 5} http://127.0.0.1:${at.port}/api/chat --data-binary @-`, {
      stdin: body,
      timeoutMs,
      maxBytes: 512 * 1024,
    });
    try {
      const j = JSON.parse(r.stdout) as { message?: { content?: string }; error?: string };
      if (j.error) throw new Error(j.error);
      return j.message?.content ?? "";
    } catch (e) {
      throw new Error(`${model} on ${at.vm.name} didn't answer: ${(e as Error).message || r.stderr.slice(0, 120) || "timed out"}`);
    }
  });
}
