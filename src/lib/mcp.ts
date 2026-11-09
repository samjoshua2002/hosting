// MCP connectors: remote Model Context Protocol servers (Streamable HTTP transport) whose tools the Assistant can
// use. The list is kept with the dashboard's data; tokens are sealed. Minimal client: initialize → tools/list →
// tools/call, JSON or server-sent-event responses, the Mcp-Session-Id header kept per call.
import { seal, unseal, type Sealed } from "./seal";
import { storeGetJson, storePut } from "./store";

const PATH = "assistant/mcp.json";
const PURPOSE = "mcp:v1";
const PROTOCOL = "2025-06-18";
export const MCP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
}
export interface McpServer {
  name: string;
  url: string;
  enabled: boolean;
  tools: McpTool[];
  checkedAt?: number;
  error?: string;
  /** sealed bearer token or full Authorization header value */
  auth?: Sealed;
}
/** What the UI sees: never the token. */
export type McpServerInfo = Omit<McpServer, "auth"> & { hasToken: boolean };

/** Well-known remote servers to start from. */
export const MCP_SUGGESTIONS: { name: string; url: string; about: string; token?: string }[] = [
  { name: "context7", url: "https://mcp.context7.com/mcp", about: "Up-to-date docs and code examples for any library or framework" },
  { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp", about: "Ask questions about any public GitHub repository" },
  { name: "huggingface", url: "https://huggingface.co/mcp", about: "Search models, datasets and Spaces on Hugging Face" },
  { name: "cloudflare-docs", url: "https://docs.mcp.cloudflare.com/mcp", about: "Search Cloudflare's documentation" },
  { name: "github", url: "https://api.githubcopilot.com/mcp/", about: "GitHub's official server: issues, PRs, code search, Actions", token: "a GitHub personal access token" },
];

let cache: { at: number; list: McpServer[] } | null = null;
export const toolIndex = new Map<string, McpTool>(); // "server/tool" → tool, for approval decisions

async function load(): Promise<McpServer[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  const list = (await storeGetJson<McpServer[]>(PATH)) ?? [];
  cache = { at: Date.now(), list };
  toolIndex.clear();
  for (const s of list) for (const t of s.tools) toolIndex.set(`${s.name}/${t.name}`, t);
  return list;
}
async function save(list: McpServer[]) {
  await storePut(PATH, JSON.stringify(list));
  cache = { at: Date.now(), list };
  toolIndex.clear();
  for (const s of list) for (const t of s.tools) toolIndex.set(`${s.name}/${t.name}`, t);
}

export async function listServers(): Promise<McpServerInfo[]> {
  return (await load()).map(({ auth, ...s }) => ({ ...s, hasToken: Boolean(auth) }));
}

/* ---------------- protocol ---------------- */

interface Conn {
  url: string;
  auth?: string;
  session?: string;
}
let seq = 1;

function authHeader(raw?: string): Record<string, string> {
  if (!raw) return {};
  return { Authorization: /^(bearer|basic|token)\s/i.test(raw) ? raw : `Bearer ${raw}` };
}

/** One JSON-RPC request; returns its result (handles JSON and text/event-stream answers). */
async function rpc(c: Conn, method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
  const id = seq++;
  const res = await fetch(c.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL,
      ...(c.session ? { "Mcp-Session-Id": c.session } : {}),
      ...authHeader(c.auth),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) c.session = sid;
  if (res.status === 401 || res.status === 403) throw new Error(`the server refused access (${res.status}): it needs a valid token`);
  if (!res.ok) throw new Error(`the server answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const type = res.headers.get("content-type") ?? "";
  let msg: { id?: number; result?: unknown; error?: { message?: string } } | undefined;
  if (type.includes("text/event-stream")) {
    const text = await res.text();
    for (const block of text.split(/\n\n+/)) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m.id === id) msg = m;
      } catch {
        /* keep-alives */
      }
    }
  } else msg = (await res.json()) as typeof msg;
  if (!msg) throw new Error("the server sent no answer");
  if (msg.error) throw new Error(msg.error.message ?? "the server reported an error");
  return msg.result;
}

async function notify(c: Conn, method: string) {
  await fetch(c.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, ...(c.session ? { "Mcp-Session-Id": c.session } : {}), ...authHeader(c.auth) },
    body: JSON.stringify({ jsonrpc: "2.0", method }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
}

async function open(url: string, auth?: string): Promise<Conn> {
  const c: Conn = { url, auth };
  await rpc(c, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "hosting-dashboard", version: "1.0.0" } });
  await notify(c, "notifications/initialized");
  return c;
}

function checkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("MCP servers must use https");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || u.hostname.endsWith(".internal")) throw new Error("private network addresses aren't allowed");
  return u.toString();
}

async function fetchTools(url: string, auth?: string): Promise<McpTool[]> {
  const c = await open(url, auth);
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = (await rpc(c, "tools/list", cursor ? { cursor } : {})) as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]; nextCursor?: string };
    for (const t of r.tools ?? [])
      tools.push({ name: t.name, description: (t.description ?? "").slice(0, 600), inputSchema: t.inputSchema, readOnly: t.annotations?.readOnlyHint, destructive: t.annotations?.destructiveHint });
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return tools.slice(0, 200);
}

/* ---------------- management ---------------- */

export async function addServer(name: string, url: string, token?: string): Promise<McpServerInfo> {
  if (!MCP_NAME_RE.test(name)) throw new Error("name: lowercase letters, digits and dashes");
  const clean = checkUrl(url);
  const list = await load();
  if (list.some((s) => s.name === name)) throw new Error(`a connector called ${name} already exists`);
  const tools = await fetchTools(clean, token || undefined);
  const s: McpServer = { name, url: clean, enabled: true, tools, checkedAt: Date.now(), auth: token ? seal(token, PURPOSE) : undefined };
  await save([...list, s]);
  const { auth, ...info } = s;
  return { ...info, hasToken: Boolean(auth) };
}

export async function removeServer(name: string): Promise<void> {
  await save((await load()).filter((s) => s.name !== name));
}

export async function setEnabled(name: string, enabled: boolean): Promise<void> {
  await save((await load()).map((s) => (s.name === name ? { ...s, enabled } : s)));
}

export async function refreshServer(name: string): Promise<McpServerInfo> {
  const list = await load();
  const s = list.find((x) => x.name === name);
  if (!s) throw new Error(`no connector called ${name}`);
  let next: McpServer;
  try {
    next = { ...s, tools: await fetchTools(s.url, s.auth ? unseal(s.auth, PURPOSE) : undefined), checkedAt: Date.now(), error: undefined };
  } catch (e) {
    next = { ...s, checkedAt: Date.now(), error: (e as Error).message.slice(0, 200) };
  }
  await save(list.map((x) => (x.name === name ? next : x)));
  const { auth, ...info } = next;
  return { ...info, hasToken: Boolean(auth) };
}

/** Run one tool. Returns its text content (and notes structured/binary parts). */
export async function callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const s = (await load()).find((x) => x.name === server);
  if (!s) throw new Error(`no connector called ${server}`);
  if (!s.enabled) throw new Error(`the ${server} connector is turned off`);
  return callUrl(s.url, tool, args, s.auth ? unseal(s.auth, PURPOSE) : undefined);
}

/** Tools of a server, without saving anything (for checks). */
export function probeServer(url: string, token?: string): Promise<McpTool[]> {
  return fetchTools(checkUrl(url), token);
}

/** One tools/call against a server URL. */
export async function callUrl(url: string, tool: string, args: Record<string, unknown>, token?: string): Promise<{ ok: boolean; text: string }> {
  const c = await open(checkUrl(url), token);
  const r = (await rpc(c, "tools/call", { name: tool, arguments: args }, 120_000)) as {
    content?: { type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const parts = (r.content ?? []).map((p) =>
    p.type === "text" ? (p.text ?? "") : p.type === "resource" ? `[resource ${p.resource?.uri ?? ""}]\n${p.resource?.text ?? ""}` : `[${p.type}${p.mimeType ? ` ${p.mimeType}` : ""} not shown]`,
  );
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return { ok: !r.isError, text: parts.join("\n\n").slice(0, 60_000) || "(no content)" };
}

/** For the system prompt: connected servers and their tools, one line each. */
export async function mcpSummary(): Promise<string> {
  const list = (await load().catch(() => [] as McpServer[])).filter((s) => s.enabled && s.tools.length);
  if (!list.length) return "";
  return `MCP connectors (use mcp_call {server, tool, arguments}; mcp_tools {server} shows a tool's input schema):\n${list
    .map((s) => `- ${s.name}: ${s.tools.map((t) => t.name).join(", ").slice(0, 600)}`)
    .join("\n")}`;
}

/** The input schema of a server's tools, for mcp_tools. */
export async function serverTools(server: string): Promise<McpTool[]> {
  const s = (await load()).find((x) => x.name === server);
  if (!s) throw new Error(`no connector called ${server}`);
  return s.tools;
}
