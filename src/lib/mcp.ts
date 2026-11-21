// MCP connectors: Model Context Protocol servers (Streamable HTTP or stdio command transport)
// whose tools the Assistant can use. Standard universal mcpServers config is maintained.
import { getVms } from "./config";
import { seal, unseal, type Sealed } from "./seal";
import { run, shq, withVm } from "./ssh";
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

export interface UniversalMcpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  token?: string;
}

export interface UniversalMcpConfig {
  mcpServers: Record<string, UniversalMcpServerDef>;
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
  transport?: "http" | "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
/** What the UI sees: never the token. */
export type McpServerInfo = Omit<McpServer, "auth"> & { hasToken: boolean; transport: "http" | "stdio" };

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
  return (await load()).map(({ auth, ...s }) => ({ ...s, transport: s.transport || "http", hasToken: Boolean(auth) }));
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
  const trimmed = raw.trim();
  // Support JSON headers: {"X-Api-Key": "...", "Authorization": "..."}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === "object" && obj !== null) {
        const res: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) res[k] = String(v);
        return res;
      }
    } catch {
      /* fallback to standard header parsing */
    }
  }
  // Support multi-line or single-line "Header-Name: value" (e.g. X-Api-Key: abc)
  if (trimmed.includes(":") && !/^(bearer|basic|token)\s/i.test(trimmed)) {
    const lines = trimmed.split("\n");
    const res: Record<string, string> = {};
    let hasHeader = false;
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        hasHeader = true;
        res[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    if (hasHeader) return res;
  }
  return { Authorization: /^(bearer|basic|token)\s/i.test(trimmed) ? trimmed : `Bearer ${trimmed}` };
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
  if (res.status === 405 && c.url.includes("shadcn.com")) {
    throw new Error("ui.shadcn.com/mcp is an HTML documentation webpage, not a remote MCP server. The official Shadcn MCP is a local CLI tool run via 'npx shadcn@latest mcp'.");
  }
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

export async function addServer(
  name: string,
  urlOrCommand: string,
  token?: string,
  opts?: {
    transport?: "http" | "stdio";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  },
): Promise<McpServerInfo> {
  if (!MCP_NAME_RE.test(name)) throw new Error("name: lowercase letters, digits and dashes");
  const list = await load();
  if (list.some((s) => s.name === name)) throw new Error(`a connector called ${name} already exists`);

  const isStdio = opts?.transport === "stdio" || Boolean(opts?.command) || (!urlOrCommand.startsWith("http://") && !urlOrCommand.startsWith("https://"));

  if (isStdio) {
    const rawCmd = (opts?.command || urlOrCommand).trim();
    const parts = rawCmd.split(/\s+/);
    const cmd = opts?.command || parts[0];
    const args = opts?.args || (opts?.command ? [] : parts.slice(1));
    const env = opts?.env;
    let tools: McpTool[] = [];
    let error: string | undefined;
    try {
      tools = await probeStdioTools(cmd, args, env);
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
    }
    const s: McpServer = {
      name,
      url: `stdio://${cmd}${args.length ? ` ${args.join(" ")}` : ""}`,
      enabled: true,
      tools,
      checkedAt: Date.now(),
      error,
      transport: "stdio",
      command: cmd,
      args,
      env,
    };
    await save([...list, s]);
    const { auth, ...info } = s;
    return { ...info, transport: "stdio", hasToken: false };
  } else {
    const clean = checkUrl(urlOrCommand);
    const tools = await fetchTools(clean, token || undefined);
    const s: McpServer = {
      name,
      url: clean,
      enabled: true,
      tools,
      checkedAt: Date.now(),
      auth: token ? seal(token, PURPOSE) : undefined,
      transport: "http",
    };
    await save([...list, s]);
    const { auth, ...info } = s;
    return { ...info, transport: "http", hasToken: Boolean(auth) };
  }
}

export async function removeServer(name: string): Promise<void> {
  await save((await load()).filter((s) => s.name !== name));
}

export async function setEnabled(name: string, enabled: boolean): Promise<void> {
  await save((await load()).map((s) => (s.name === name ? { ...s, enabled } : s)));
}

/* ---------------- stdio execution ---------------- */

async function runStdioMcp(cmd: string, args: string[], env: Record<string, string> | undefined, stdinLines: string[]): Promise<string> {
  const vms = getVms();
  const stdin = stdinLines.join("\n") + "\n";
  const envPrefix = env ? Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(" ") + " " : "";
  const fullCmd = `${envPrefix}${cmd}${args.length ? ` ${args.map((a) => shq(a)).join(" ")}` : ""}`;

  if (vms.length > 0) {
    const targetVm = vms.find((v) => v.name === "box1") || vms[0];
    const res = await withVm(targetVm, (c) => run(c, fullCmd, { stdin, timeoutMs: 45_000, maxBytes: 1024 * 1024 }));
    return res.stdout;
  }

  // Local fallback (child_process)
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("child_process");
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code: number) => {
      if (code !== 0 && !stdout) reject(new Error(stderr || `Command exited with code ${code}`));
      else resolve(stdout);
    });
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

async function probeStdioTools(cmd: string, args: string[], env?: Record<string, string>): Promise<McpTool[]> {
  const initReq = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "hosting", version: "1.0" } } });
  const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listReq = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  const stdout = await runStdioMcp(cmd, args, env, [initReq, notif, listReq]);
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.id === 2 && obj.result && Array.isArray(obj.result.tools)) {
        return obj.result.tools.map((t: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }) => ({
          name: t.name,
          description: (t.description ?? "").slice(0, 600),
          inputSchema: t.inputSchema,
          readOnly: t.annotations?.readOnlyHint,
          destructive: t.annotations?.destructiveHint,
        }));
      }
    } catch {
      /* continue looking for json-rpc line */
    }
  }
  return [];
}

async function callStdioTool(s: McpServer, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  if (!s.command) throw new Error(`Server ${s.name} has no command defined`);
  const initReq = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "hosting", version: "1.0" } } });
  const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const callReq = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });

  const stdout = await runStdioMcp(s.command, s.args || [], s.env, [initReq, notif, callReq]);
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.id === 2) {
        if (obj.error) return { ok: false, text: obj.error.message || "MCP tool error" };
        const content = obj.result?.content || [];
        const parts = Array.isArray(content)
          ? content.map((p: { type: string; text?: string }) => (p.type === "text" ? p.text ?? "" : JSON.stringify(p))).join("\n\n")
          : JSON.stringify(obj.result, null, 2);
        return { ok: true, text: parts.slice(0, 60_000) || "(empty response)" };
      }
    } catch {
      /* continue */
    }
  }
  return { ok: true, text: stdout.slice(0, 60_000) || "(completed)" };
}

/* ---------------- universal config ---------------- */

export async function exportUniversalConfig(): Promise<UniversalMcpConfig> {
  const list = await load();
  const mcpServers: Record<string, UniversalMcpServerDef> = {};
  for (const s of list) {
    if (s.transport === "stdio" && s.command) {
      mcpServers[s.name] = {
        command: s.command,
        args: s.args,
        env: s.env,
      };
    } else {
      mcpServers[s.name] = {
        url: s.url,
      };
    }
  }
  return { mcpServers };
}

export async function importUniversalConfig(input: unknown): Promise<McpServerInfo[]> {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error("Invalid JSON: could not parse MCP config");
    }
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Config must be a JSON object containing 'mcpServers'");
  const root = parsed as Record<string, unknown>;
  const serversMap = ((root.mcpServers || root.servers || root) as Record<string, Record<string, unknown>>);
  if (!serversMap || typeof serversMap !== "object") throw new Error("Config missing 'mcpServers' object");

  const existing = await load();
  const nextList: McpServer[] = [...existing];

  for (const [rawName, def] of Object.entries(serversMap)) {
    if (!def || typeof def !== "object") continue;
    const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!name) continue;

    const idx = nextList.findIndex((s) => s.name === name);
    if (idx >= 0) nextList.splice(idx, 1);

    if (typeof def.url === "string" && def.url.trim()) {
      const cleanUrl = checkUrl(def.url.trim());
      let authStr: string | undefined;
      if (def.headers && typeof def.headers === "object") {
        authStr = JSON.stringify(def.headers);
      } else if (typeof def.token === "string" && def.token.trim()) {
        authStr = def.token.trim();
      }
      let tools: McpTool[] = [];
      let error: string | undefined;
      try {
        tools = await fetchTools(cleanUrl, authStr);
      } catch (e) {
        error = (e as Error).message.slice(0, 200);
      }
      nextList.push({
        name,
        url: cleanUrl,
        enabled: true,
        tools,
        checkedAt: Date.now(),
        error,
        auth: authStr ? seal(authStr, PURPOSE) : undefined,
        transport: "http",
      });
    } else if (typeof def.command === "string" && def.command.trim()) {
      const cmd = def.command.trim();
      const args = Array.isArray(def.args) ? def.args.map(String) : [];
      const env = def.env && typeof def.env === "object" ? (def.env as Record<string, string>) : undefined;
      let tools: McpTool[] = [];
      let error: string | undefined;
      try {
        tools = await probeStdioTools(cmd, args, env);
      } catch (e) {
        error = (e as Error).message.slice(0, 200);
      }
      nextList.push({
        name,
        url: `stdio://${cmd}${args.length ? ` ${args.join(" ")}` : ""}`,
        enabled: true,
        tools,
        checkedAt: Date.now(),
        error,
        transport: "stdio",
        command: cmd,
        args,
        env,
      });
    }
  }

  await save(nextList);
  return listServers();
}

export async function refreshServer(name: string): Promise<McpServerInfo> {
  const list = await load();
  const s = list.find((x) => x.name === name);
  if (!s) throw new Error(`no connector called ${name}`);
  let next: McpServer;
  try {
    const tools = s.transport === "stdio" && s.command
      ? await probeStdioTools(s.command, s.args || [], s.env)
      : await fetchTools(s.url, s.auth ? unseal(s.auth, PURPOSE) : undefined);
    next = { ...s, tools, checkedAt: Date.now(), error: undefined };
  } catch (e) {
    next = { ...s, checkedAt: Date.now(), error: (e as Error).message.slice(0, 200) };
  }
  await save(list.map((x) => (x.name === name ? next : x)));
  const { auth, ...info } = next;
  return { ...info, transport: next.transport || "http", hasToken: Boolean(auth) };
}

/** Run one tool. Returns its text content (and notes structured/binary parts). */
export async function callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const s = (await load()).find((x) => x.name === server);
  if (!s) throw new Error(`no connector called ${server}`);
  if (!s.enabled) throw new Error(`the ${server} connector is turned off`);
  if (s.transport === "stdio" && s.command) {
    return callStdioTool(s, tool, args);
  }
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

/** For the system prompt: connected servers and their tools with domain & descriptions. */
export async function mcpSummary(off?: string[]): Promise<string> {
  const no = new Set((off ?? []).map((x) => x.toLowerCase()));
  const list = (await load().catch(() => [] as McpServer[])).filter((s) => s.enabled && !no.has(s.name.toLowerCase()));
  if (!list.length) return "";
  return `Connected MCP servers (call them with mcp_call {server, tool, arguments}; inspect schema with mcp_tools {server}):\n${list
    .map((s) => {
      const toolSummaries = s.tools.slice(0, 8).map((t) => `${t.name}${t.description ? ` (${t.description.slice(0, 75)})` : ""}`).join("; ");
      const about = s.tools.length ? `tools: [${toolSummaries}]` : `transport: ${s.transport || "http"}`;
      return `- ${s.name} (${s.transport || "http"}): ${about}`;
    })
    .join("\n")}`;
}

/** The input schema of a server's tools, for mcp_tools. */
export async function serverTools(server: string): Promise<McpTool[]> {
  const s = (await load()).find((x) => x.name === server);
  if (!s) throw new Error(`no connector called ${server}`);
  return s.tools;
}
