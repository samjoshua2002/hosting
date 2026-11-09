// Azure OpenAI client (plain fetch). Discovers deployments, falls back across models on 404/429/5xx.

export interface Deployment {
  id: string;
  model: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function aiConfigured(): boolean {
  return Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);
}

const base = () => (process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
const version = () => process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";
const key = () => process.env.AZURE_OPENAI_API_KEY ?? "";

export const agentModel = () => process.env.AZURE_OPENAI_AGENT_MODEL || "gpt-5.6-luna";
export const fastModel = () => process.env.AZURE_OPENAI_FAST_MODEL || "gpt-5.4-mini";
const fallbacks = () => ["gpt-5.1", process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o", "gpt-4o"];

let deploymentCache: { at: number; list: Deployment[] } | null = null;

/** Deployments on the Azure resource (cached 10 min). */
export async function listDeployments(): Promise<Deployment[]> {
  if (deploymentCache && Date.now() - deploymentCache.at < 10 * 60 * 1000) return deploymentCache.list;
  try {
    const res = await fetch(`${base()}/openai/deployments?api-version=2022-12-01`, {
      headers: { "api-key": key() },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { data?: { id: string; model: string }[] };
    const list = (data.data ?? []).map((d) => ({ id: d.id, model: d.model }));
    deploymentCache = { at: Date.now(), list };
    return list;
  } catch {
    return [...new Set([agentModel(), fastModel(), ...fallbacks()])].map((id) => ({ id, model: id }));
  }
}

export interface ChatResult {
  message: Extract<ChatMessage, { role: "assistant" }>;
  model: string;
  usage?: { total_tokens?: number };
}

export async function chat(opts: {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
}): Promise<ChatResult> {
  if (!aiConfigured()) throw new Error("Azure OpenAI is not configured");
  const chain = [...new Set([opts.model, agentModel(), ...fallbacks()].filter((m): m is string => Boolean(m)))];
  let lastError = "no deployment available";
  for (const deployment of chain) {
    const body: Record<string, unknown> = {
      messages: opts.messages,
      max_completion_tokens: opts.maxTokens ?? 2500,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? "auto";
    }
    if (opts.json) body.response_format = { type: "json_object" };
    let res: Response;
    try {
      res = await fetch(`${base()}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${version()}`, {
        method: "POST",
        headers: { "api-key": key(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      lastError = `${deployment}: ${(e as Error).message}`;
      continue;
    }
    if (res.ok) {
      const data = (await res.json()) as { choices: { message: ChatResult["message"] }[]; usage?: ChatResult["usage"] };
      return { message: data.choices[0].message, model: deployment, usage: data.usage };
    }
    const text = await res.text().catch(() => "");
    lastError = `${deployment}: ${res.status} ${text.slice(0, 200)}`;
    if (![404, 408, 429, 500, 502, 503, 504].includes(res.status)) break; // a real error: don't hide it behind fallbacks
  }
  throw new Error(`AI request failed (${lastError})`);
}

/** Look at an image (a screenshot) with the vision deployment and answer a question about it. */
export async function describeImage(image: Buffer, question: string, mime = "image/png"): Promise<string> {
  if (!aiConfigured()) throw new Error("Azure OpenAI is not configured");
  const deployments = [...new Set([process.env.AZURE_OPENAI_VISION_DEPLOYMENT, "gpt-4o", agentModel()].filter((m): m is string => Boolean(m)))];
  let last = "";
  for (const d of deployments) {
    const res = await fetch(`${base()}/openai/deployments/${encodeURIComponent(d)}/chat/completions?api-version=${version()}`, {
      method: "POST",
      headers: { "api-key": key(), "Content-Type": "application/json" },
      body: JSON.stringify({
        max_completion_tokens: 500,
        messages: [{ role: "user", content: [{ type: "text", text: question }, { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } }] }],
      }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as unknown as Response);
    if (res.ok) {
      const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
      return (data.choices[0]?.message.content ?? "").trim();
    }
    last = `${d}: ${res.status} ${(await res.text()).slice(0, 160)}`;
  }
  throw new Error(`couldn't look at the image (${last})`);
}
