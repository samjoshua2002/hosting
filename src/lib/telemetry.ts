// Langfuse tracing for the Assistant. One trace per Assistant run, grouped by conversation (sessionId); every
// model call is a generation and every tool call a span inside it, so a session shows exactly which skills,
// MCP servers, connectors and commands it used. Nothing secret leaves: content is scrubbed and clipped first,
// and LANGFUSE_LOG_CONTENT=0 sends timings, models, tokens and tool names only.
import { AsyncLocalStorage } from "node:async_hooks";
import { Langfuse, type LangfuseTraceClient } from "langfuse";

let instance: Langfuse | null = null;
const current = new AsyncLocalStorage<LangfuseTraceClient | null>();

export function isLangfuseConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
}

/** Langfuse's docs use LANGFUSE_BASE_URL (and LANGFUSE_HOST); LANGFUSE_BASEURL is accepted too. */
export function langfuseBaseUrl(): string {
  return (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASEURL || "https://cloud.langfuse.com").replace(/\/$/, "");
}

function lf(): Langfuse | null {
  if (!isLangfuseConfigured()) return null;
  instance ??= new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    baseUrl: langfuseBaseUrl(),
    flushAt: 20,
    flushInterval: 2000,
  });
  return instance;
}

const logContent = () => process.env.LANGFUSE_LOG_CONTENT !== "0";

/* ---------------- scrubbing ---------------- */

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,})/g, "sk-••••"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/g, "gh_••••"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA••••"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox-••••"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza••••"],
  [/\bibssh_[A-Za-z0-9]{6,}/g, "ibssh_••••"],
  [/\b(?:rnd|vcp|pk|rk|sk)_(?:live_|test_)?[A-Za-z0-9]{16,}/g, "key_••••"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "jwt••••"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, "$1••••@"],
  [/([?&](?:_token|token|key|secret|password|sig)=)[^&\s"']+/gi, "$1••••"],
  // KEY=value / "password": "…" style assignments of anything that looks secret
  [/\b([A-Z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)(\s*[=:]\s*)("?)[^\s"',;]+\3/g, "$1$2$3••••$3"],
  [/("(?:password|secret|token|api_?key|authorization)"\s*:\s*")[^"]+"/gi, '$1••••"'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "-----PRIVATE KEY ••••-----"],
];

export function scrub(text: string, max = 6000): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out.length > max ? `${out.slice(0, max)}… (${out.length - max} more chars)` : out;
}

/** Messages as Langfuse sees them: scrubbed, clipped, the long system prompt summarised. */
function scrubMessages(messages: unknown): unknown {
  if (!logContent()) return undefined;
  if (!Array.isArray(messages)) return scrub(JSON.stringify(messages ?? ""));
  return messages.slice(-24).map((m: Record<string, unknown>) => {
    const content = typeof m.content === "string" ? m.content : m.content == null ? null : JSON.stringify(m.content);
    return {
      role: m.role,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: scrub(JSON.stringify(m.tool_calls), 4000) } : {}),
      content: content == null ? null : m.role === "system" ? `[system prompt, ${content.length} chars]` : scrub(content, 4000),
    };
  });
}

/* ---------------- traces ---------------- */

export interface TraceContext {
  name: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input?: string;
}

/** Run fn inside a trace: every chat() and recordSpan() in it attaches to that trace. Always flushes. */
export async function withTrace<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  const client = lf();
  let trace: LangfuseTraceClient | null = null;
  if (client) {
    try {
      trace = client.trace({
        name: ctx.name,
        sessionId: ctx.sessionId,
        userId: ctx.userId || "admin",
        tags: ctx.tags,
        metadata: ctx.metadata,
        input: ctx.input && logContent() ? scrub(ctx.input, 4000) : undefined,
      });
    } catch (err) {
      console.warn("[langfuse] trace error:", (err as Error).message);
    }
  }
  try {
    return await current.run(trace, fn);
  } finally {
    await flushTelemetry();
  }
}

/** Record a model call (attached to the current trace when there is one). */
export function recordGeneration(opts: {
  name?: string;
  model: string;
  input: unknown;
  output?: unknown;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  startTime?: Date;
  endTime?: Date;
  error?: string;
}): void {
  const client = lf();
  if (!client) return;
  try {
    const parent = current.getStore() ?? client;
    parent.generation({
      name: opts.name || "azure-openai-chat",
      model: opts.model,
      input: scrubMessages(opts.input),
      output: opts.output && logContent() ? (scrubMessages([opts.output]) as unknown[] | undefined)?.[0] : undefined,
      startTime: opts.startTime || new Date(),
      endTime: opts.endTime || new Date(),
      usage: opts.usage ? { input: opts.usage.prompt_tokens, output: opts.usage.completion_tokens, total: opts.usage.total_tokens, unit: "TOKENS" } : undefined,
      level: opts.error ? "ERROR" : "DEFAULT",
      statusMessage: opts.error ? scrub(opts.error, 500) : undefined,
    });
  } catch (err) {
    console.warn("[langfuse] generation error:", (err as Error).message);
  }
}

/** Record a tool call (skill, MCP, connector, command…) under the current trace. */
export function recordSpan(opts: { name: string; input?: unknown; output?: unknown; startTime?: Date; endTime?: Date; error?: string; metadata?: Record<string, unknown> }): void {
  const trace = current.getStore();
  if (!trace) return;
  try {
    trace.span({
      name: opts.name,
      input: logContent() && opts.input !== undefined ? scrub(typeof opts.input === "string" ? opts.input : JSON.stringify(opts.input), 3000) : undefined,
      output: logContent() && opts.output !== undefined ? scrub(typeof opts.output === "string" ? opts.output : JSON.stringify(opts.output), 3000) : undefined,
      startTime: opts.startTime || new Date(),
      endTime: opts.endTime || new Date(),
      level: opts.error ? "ERROR" : "DEFAULT",
      statusMessage: opts.error ? scrub(opts.error, 500) : undefined,
      metadata: opts.metadata,
    });
  } catch (err) {
    console.warn("[langfuse] span error:", (err as Error).message);
  }
}

/** Set the trace's final output (the Assistant's last reply). */
export function traceOutput(text: string): void {
  const trace = current.getStore();
  if (!trace || !logContent()) return;
  try {
    trace.update({ output: scrub(text, 4000) });
  } catch {
    /* ignore */
  }
}

/** Send what's buffered (called at the end of every traced run; serverless functions may stop right after). */
export async function flushTelemetry(): Promise<void> {
  const client = lf();
  if (!client) return;
  try {
    await client.flushAsync();
  } catch (err) {
    console.warn("[langfuse] flush error:", (err as Error).message);
  }
}
