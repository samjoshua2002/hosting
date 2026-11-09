// Langfuse tracing for the Assistant, sent over OpenTelemetry (Langfuse's current ingestion; the old v3 event API is
// refused for new accounts). One trace per Assistant run, grouped by conversation (session.id); every model call is
// a generation and every tool call a span inside it, so a session shows exactly which skills, MCP servers,
// connectors and commands it used. Nothing secret leaves: content is scrubbed and clipped first, and
// LANGFUSE_LOG_CONTENT=0 sends timings, models, tokens and tool names only.
import { AsyncLocalStorage } from "node:async_hooks";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseOtelSpanAttributes as A, setLangfuseTracerProvider, startObservation, type LangfuseAgent } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

let processor: LangfuseSpanProcessor | null = null;

interface Run {
  root: LangfuseAgent;
  /** trace-wide attributes, copied onto every span so filters work on each one */
  attrs: Record<string, string | string[]>;
}
const current = new AsyncLocalStorage<Run | null>();

export function isLangfuseConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
}

/** Langfuse's docs use LANGFUSE_BASE_URL (and LANGFUSE_HOST); LANGFUSE_BASEURL is accepted too. */
export function langfuseBaseUrl(): string {
  return (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASEURL || "https://cloud.langfuse.com").replace(/\/$/, "");
}

/** A private tracer provider just for Langfuse (it never touches the app's global OpenTelemetry setup). */
function ready(): boolean {
  if (!isLangfuseConfigured()) return false;
  if (!processor) {
    processor = new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
      secretKey: process.env.LANGFUSE_SECRET_KEY!,
      baseUrl: langfuseBaseUrl(),
      // serverless functions can freeze right after responding: send each span as it ends
      exportMode: "immediate",
      environment: (process.env.VERCEL_ENV || process.env.NODE_ENV || "development").toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
    });
    setLangfuseTracerProvider(new NodeTracerProvider({ spanProcessors: [processor] }));
  }
  return true;
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
  // lower/mixed-case forms in prose and commands: password=…, token: …, --password …, Bearer …
  [/\b(passw(?:or)?d|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)(["']?)(?!••••)[^\s"',;]{3,}\3/gi, "$1$2$3••••$3"],
  [/(--(?:passw(?:or)?d|token|secret|api[_-]?key)\s+)(["']?)[^\s"']{3,}\2/gi, "$1$2••••$2"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ••••"],
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

const clip200 = (v: string) => v.slice(0, 200);

/** Run fn inside a trace: every chat() and recordSpan() in it attaches to that trace. Always flushes. */
export async function withTrace<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  let run: Run | null = null;
  if (ready()) {
    try {
      const attrs: Run["attrs"] = { [A.TRACE_NAME]: clip200(ctx.name), [A.TRACE_USER_ID]: clip200(ctx.userId || "admin") };
      if (ctx.sessionId) attrs[A.TRACE_SESSION_ID] = clip200(ctx.sessionId);
      if (ctx.tags?.length) attrs[A.TRACE_TAGS] = ctx.tags;
      const root = startObservation(ctx.name, { input: ctx.input && logContent() ? scrub(ctx.input, 4000) : undefined, metadata: ctx.metadata }, { asType: "agent" });
      root.otelSpan.setAttributes(attrs);
      run = { root, attrs };
    } catch (err) {
      console.warn("[langfuse] trace error:", (err as Error).message);
    }
  }
  try {
    return await current.run(run, fn);
  } catch (err) {
    run?.root.update({ level: "ERROR", statusMessage: scrub((err as Error).message ?? String(err), 500) });
    throw err;
  } finally {
    try {
      run?.root.end();
    } catch {
      /* ignore */
    }
    await flushTelemetry();
  }
}

/** A child observation of the current run (or a stand-alone one outside a run), ended straight away. */
function child(name: string, type: "generation" | "tool", attributes: Record<string, unknown>, start?: Date, end?: Date) {
  const run = current.getStore();
  const opts = { asType: type, startTime: start ?? new Date(), ...(run ? { parentSpanContext: run.root.otelSpan.spanContext() } : {}) };
  // the overloads differ only by asType; the attributes object matches both shapes
  const obs = (startObservation as unknown as (n: string, a: Record<string, unknown>, o: typeof opts) => { otelSpan: { setAttributes(a: Run["attrs"]): void }; end(t?: Date): void })(name, attributes, opts);
  if (run) obs.otelSpan.setAttributes(run.attrs);
  obs.end(end ?? new Date());
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
  if (!ready()) return;
  try {
    const u = opts.usage;
    child(
      opts.name || "azure-openai-chat",
      "generation",
      {
        model: opts.model,
        input: scrubMessages(opts.input),
        output: opts.output && logContent() ? (scrubMessages([opts.output]) as unknown[] | undefined)?.[0] : undefined,
        usageDetails: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, total: u.total_tokens ?? 0 } : undefined,
        level: opts.error ? "ERROR" : "DEFAULT",
        statusMessage: opts.error ? scrub(opts.error, 500) : undefined,
      },
      opts.startTime,
      opts.endTime,
    );
  } catch (err) {
    console.warn("[langfuse] generation error:", (err as Error).message);
  }
}

/** Record a tool call (skill, MCP, connector, command…) under the current trace. */
export function recordSpan(opts: { name: string; input?: unknown; output?: unknown; startTime?: Date; endTime?: Date; error?: string; metadata?: Record<string, unknown> }): void {
  if (!current.getStore()) return;
  const text = (v: unknown) => scrub(typeof v === "string" ? v : JSON.stringify(v), 3000);
  try {
    child(
      opts.name,
      "tool",
      {
        input: logContent() && opts.input !== undefined ? text(opts.input) : undefined,
        output: logContent() && opts.output !== undefined ? text(opts.output) : undefined,
        level: opts.error ? "ERROR" : "DEFAULT",
        statusMessage: opts.error ? scrub(opts.error, 500) : undefined,
        metadata: opts.metadata,
      },
      opts.startTime,
      opts.endTime,
    );
  } catch (err) {
    console.warn("[langfuse] span error:", (err as Error).message);
  }
}

/** Set the run's final output (the Assistant's last reply). */
export function traceOutput(text: string): void {
  const run = current.getStore();
  if (!run || !logContent()) return;
  try {
    run.root.update({ output: scrub(text, 4000) });
  } catch {
    /* ignore */
  }
}

/** Send what's buffered (called at the end of every traced run; serverless functions may stop right after). */
export async function flushTelemetry(): Promise<void> {
  if (!processor) return;
  try {
    await processor.forceFlush();
  } catch (err) {
    console.warn("[langfuse] flush error:", (err as Error).message);
  }
}
