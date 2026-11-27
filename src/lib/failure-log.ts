// Failure log: every place the Assistant failed or got stuck, kept so it can be fixed later.
// Only failures are stored (never successful steps): a tool that returned an error or crashed, the same
// error repeating (stuck in a loop), the model call failing, a run crashing, running out of rounds or time,
// and plan steps marked failed or left unfinished. One small JSON file per entry under assistant/failures/,
// secrets scrubbed, newest kept (older than 90 days or beyond 2000 entries are pruned).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { storeDelete, storeList, storePut, storeReadJsonDir } from "./store";
import { scrub } from "./telemetry";

export type FailureKind =
  | "tool_failed" // a tool ran and reported an error
  | "tool_crashed" // a tool threw before it could report
  | "stuck_loop" // the same tool failed the same way 3+ times in one run
  | "model_error" // the model call itself failed
  | "run_crashed" // the whole run stopped on an unexpected error
  | "round_limit" // used every round without finishing
  | "time_budget" // ran out of time for this request
  | "plan_step_failed" // the Assistant marked a plan step as failed
  | "unfinished_plan"; // the run ended with plan steps still not done

export interface FailureEntry {
  id: string;
  at: number;
  kind: FailureKind;
  sessionId?: string;
  model?: string;
  source?: string;
  tool?: string;
  label?: string;
  /** tool arguments, scrubbed and clipped */
  args?: string;
  error: string;
  /** how many times this exact failure repeated in the run (stuck_loop) */
  count?: number;
  /** the plan the run was working on, if any */
  plan?: string;
  resolved?: boolean;
}

const DIR = "assistant/failures";

/** Long errors (build logs) keep their start and their end: the real failure is usually the last lines. */
function headTail(text: string, head = 600, tail = 1800): string {
  return text.length <= head + tail + 40 ? text : `${text.slice(0, head)}\n…(${text.length - head - tail} characters skipped)…\n${text.slice(-tail)}`;
}
const KEEP_DAYS = 90;
const KEEP_MAX = 2000;

interface RunState {
  sessionId?: string;
  model?: string;
  source?: string;
  pending: Promise<void>[];
  /** tool + error fingerprint → times seen this run */
  repeats: Map<string, number>;
  /** plan title → steps (latest version) */
  plans: Map<string, { text: string; status: string; note?: string }[]>;
  /** fingerprints already logged as failed plan steps, so a step isn't logged on every update */
  loggedSteps: Set<string>;
  /** the run is only pausing (waiting for the user, out of time for this request, or stopped): open steps are not a failure */
  paused: boolean;
  /** loops found since the loop last asked (the Assistant is told to change approach) */
  stuck: { tool: string; error: string; count: number }[];
}

const runs = new AsyncLocalStorage<RunState>();

/** Run fn with failure tracking for one Assistant run. Waits for log writes before returning. */
export async function withFailureLog<T>(ctx: { sessionId?: string; model?: string; source?: string }, fn: () => Promise<T>): Promise<T> {
  const state: RunState = { ...ctx, pending: [], repeats: new Map(), plans: new Map(), loggedSteps: new Set(), paused: false, stuck: [] };
  try {
    return await runs.run(state, fn);
  } catch (e) {
    write(state, { kind: "run_crashed", error: (e as Error).message || String(e) });
    throw e;
  } finally {
    if (!state.paused) unfinishedPlans(state);
    await Promise.allSettled(state.pending);
  }
}

function write(state: RunState | undefined, e: Omit<FailureEntry, "id" | "at" | "sessionId" | "model" | "source">): void {
  const at = Date.now();
  const id = `${at}-${randomBytes(3).toString("hex")}`;
  const plan = state ? [...state.plans.keys()].pop() : undefined;
  const entry: FailureEntry = {
    id,
    at,
    sessionId: state?.sessionId,
    model: state?.model,
    source: state?.source,
    ...e,
    error: headTail(scrub(e.error || "unknown error", 100_000)),
    args: e.args ? scrub(e.args, 1500) : undefined,
    plan: e.plan ?? plan,
  };
  const p = storePut(`${DIR}/${id}.json`, JSON.stringify(entry)).catch((err: Error) => console.warn("[failure-log] could not save:", err.message));
  if (state) state.pending.push(p);
}

/** A short, stable fingerprint of an error: numbers, ids and paths blurred so repeats match. */
function fingerprint(tool: string, error: string): string {
  return `${tool}|${error.toLowerCase().replace(/[0-9a-f]{7,}/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 160)}`;
}

/** A tool finished. Logs it if it failed, and flags a loop when the same failure repeats. */
export function recordToolResult(opts: { tool: string; label?: string; args?: string; ok: boolean; output: string; crashed?: boolean }): void {
  if (opts.ok) return;
  const state = runs.getStore();
  const error = opts.output || "failed with no message";
  write(state, { kind: opts.crashed ? "tool_crashed" : "tool_failed", tool: opts.tool, label: opts.label, args: opts.args, error });
  if (!state) return;
  const key = fingerprint(opts.tool, error);
  const n = (state.repeats.get(key) ?? 0) + 1;
  state.repeats.set(key, n);
  if (n === 3) write(state, { kind: "stuck_loop", tool: opts.tool, label: opts.label, args: opts.args, error, count: n });
  if (n >= 3) state.stuck.push({ tool: opts.tool, error: error.slice(0, 300), count: n });
}

/** Loops found since the last call (and clears them): the Assistant loop tells the model to change approach. */
export function takeStuck(): { tool: string; error: string; count: number }[] {
  const state = runs.getStore();
  if (!state?.stuck.length) return [];
  const out = state.stuck;
  state.stuck = [];
  return out;
}

/** Plan steps still todo or doing in this run (the loop sends the model back to work while any remain). */
export function openPlanSteps(): string[] {
  const state = runs.getStore();
  if (!state) return [];
  return [...state.plans.values()].flatMap((steps) => steps.filter((s) => s.status === "todo" || s.status === "doing").map((s) => s.text));
}

/**
 * What the Assistant should learn from past runs: the open failures that keep coming back, grouped by tool
 * and error, most frequent first. Injected into its instructions so it avoids the same dead ends.
 */
export async function knownFailureSpots(max = 8): Promise<string> {
  const items = (await listFailures()).filter((f) => !f.resolved && (f.kind === "tool_failed" || f.kind === "tool_crashed" || f.kind === "stuck_loop"));
  const groups = new Map<string, { tool: string; error: string; n: number; last: number }>();
  for (const f of items) {
    const key = fingerprint(f.tool ?? "?", f.error);
    const g = groups.get(key) ?? { tool: f.tool ?? "?", error: f.error.replace(/\s+/g, " ").slice(0, 200), n: 0, last: 0 };
    g.n++;
    g.last = Math.max(g.last, f.at);
    groups.set(key, g);
  }
  const top = [...groups.values()].filter((g) => g.n >= 2).sort((a, b) => b.n - a.n || b.last - a.last).slice(0, max);
  return top.map((g) => `- ${g.tool} failed ${g.n}x: ${g.error}`).join("\n");
}

/** The model call failed (timeout, content filter, bad deployment, …). */
export function recordModelError(error: string): void {
  write(runs.getStore(), { kind: "model_error", error });
}

/** The run stopped before it finished: every round used, or out of time for this request. */
export function recordStop(kind: "round_limit" | "time_budget", detail: string): void {
  write(runs.getStore(), { kind, error: detail });
}

/** The Assistant updated its plan: log steps it marked failed (once each) and remember the plan. */
export function recordPlan(title: string, steps: { text: string; status: string; note?: string }[]): void {
  const state = runs.getStore();
  if (!state) return;
  state.plans.set(title, steps);
  for (const s of steps) {
    if (s.status !== "failed") continue;
    const key = `${title}|${s.text}`;
    if (state.loggedSteps.has(key)) continue;
    state.loggedSteps.add(key);
    write(state, { kind: "plan_step_failed", label: s.text, error: s.note || "marked failed", plan: title });
  }
}

/** At the end of a run: plan steps still todo or doing mean the work stopped part way. */
function unfinishedPlans(state: RunState): void {
  for (const [title, steps] of state.plans) {
    const open = steps.filter((s) => s.status === "todo" || s.status === "doing");
    if (!open.length) continue;
    const done = steps.filter((s) => s.status === "done").length;
    write(state, {
      kind: "unfinished_plan",
      label: open[0].text,
      error: `Stopped with ${open.length} of ${steps.length} steps not done (${done} done). Next open step: ${open[0].text}`,
      plan: title,
    });
  }
}

/** The run is pausing on purpose (approval, question, time slice, Stop): don't log open plan steps as unfinished. */
export function markPaused(): void {
  const state = runs.getStore();
  if (state) state.paused = true;
}

/** Newest first, after pruning old entries. */
export async function listFailures(): Promise<FailureEntry[]> {
  const rows = await storeReadJsonDir<FailureEntry>(DIR);
  const all = rows.map((r) => r.value).filter((v) => v && v.id && v.at).sort((a, b) => b.at - a.at);
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const drop = all.filter((v, i) => v.at < cutoff || i >= KEEP_MAX);
  if (drop.length) await Promise.allSettled(drop.map((v) => storeDelete(`${DIR}/${v.id}.json`)));
  return all.filter((v) => !drop.includes(v));
}

/** Mark entries fixed (or not), so the list shows what is still open. */
export async function setResolved(ids: string[], resolved: boolean): Promise<number> {
  const rows = await storeReadJsonDir<FailureEntry>(DIR);
  const want = new Set(ids);
  let n = 0;
  for (const { value } of rows) {
    if (!want.has(value.id) || Boolean(value.resolved) === resolved) continue;
    await storePut(`${DIR}/${value.id}.json`, JSON.stringify({ ...value, resolved }));
    n++;
  }
  return n;
}

/** Remove entries (one, several, or all resolved ones). */
export async function deleteFailures(ids: string[] | "resolved"): Promise<number> {
  let targets: string[];
  if (ids === "resolved") targets = (await storeReadJsonDir<FailureEntry>(DIR)).filter((r) => r.value.resolved).map((r) => r.value.id);
  else {
    const have = new Set((await storeList(DIR)).map((f) => f.name.replace(/\.json$/, "")));
    targets = ids.filter((id) => have.has(id));
  }
  await Promise.allSettled(targets.map((id) => storeDelete(`${DIR}/${id}.json`)));
  return targets.length;
}
