// Server side of connectors: connect (check the token against the service, remember whose account it is),
// disconnect, the live state of every connector, and the authenticated call the Assistant makes (connector_api).
import { aiConfigured } from "./ai";
import { getVms } from "./config";
import { CONNECTORS, connectorDef, type ConnectorDef } from "./connector-catalog";
import { githubAuth, githubToken } from "./github";
import { addServer, listServers, removeServer } from "./mcp";
import { storeGetJson, storePut } from "./store";
import { forgetSecret, getSecret, setSecret } from "./vault";

const META = "assistant/connectors.json";
type Meta = Record<string, { account: string; connectedAt: number }>;
const secretName = (id: string) => `CONNECTOR_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

export interface ConnectorState {
  id: string;
  connected: boolean;
  account?: string;
  detail?: string;
  connectedAt?: number;
  tools?: number;
}

async function meta(): Promise<Meta> {
  return (await storeGetJson<Meta>(META).catch(() => null)) ?? {};
}

function request(def: ConnectorDef, token: string, method: string, path: string, body?: unknown): { url: string; init: RequestInit } {
  const t = def.token!;
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "hosting-dashboard", ...(t.headers ?? {}) };
  if (t.auth === "bearer") headers.Authorization = `Bearer ${token}`;
  else if (t.auth === "bot") headers.Authorization = `Bot ${token}`;
  else if (t.auth === "x-api-key") headers["x-api-key"] = token;
  else if (t.auth === "plain") headers.Authorization = token;
  const url = t.auth === "url" ? `${t.base}/bot${token}${path}` : `${t.base}${path}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return { url, init: { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), cache: "no-store" } };
}

/** Find a human label for the account in whatever the service's "who am I" answered. */
function accountOf(json: unknown): string {
  const seen: string[] = [];
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== "object" || depth > 3 || seen.length) return;
    const r = o as Record<string, unknown>;
    for (const k of ["email", "username", "login", "name", "handle", "slug", "user", "team"]) {
      const v = r[k];
      if (typeof v === "string" && v.trim() && v.length < 80) {
        seen.push(k === "team" ? `team ${v}` : v);
        return;
      }
    }
    for (const v of Object.values(r)) walk(Array.isArray(v) ? v[0] : v, depth + 1);
  };
  walk(json, 0);
  return seen[0] ?? "connected";
}

/** Check a token against the service, then keep it (sealed) and remember whose account it is. */
export async function connectToken(id: string, token: string): Promise<ConnectorState> {
  const def = connectorDef(id);
  if (!def || def.kind !== "token" || !def.token) throw new Error("not a token connector");
  const clean = token.trim();
  if (clean.length < 8 || /\s/.test(clean)) throw new Error("that doesn't look like a token");
  const graphql = def.token.check.startsWith("graphql:");
  const { url, init } = graphql
    ? request(def, clean, "POST", "/graphql", { query: def.token.check.slice(8) })
    : request(def, clean, def.id === "slack" ? "POST" : "GET", def.token.check);
  const r = await fetch(url, init).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as unknown as Response);
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const slackFail = def.id === "slack" && json && (json as { ok?: boolean }).ok === false;
  if (!r.ok || slackFail) throw new Error(`${def.name} didn't accept that token (${r.status || "no answer"}${slackFail ? `: ${(json as { error?: string }).error}` : ""})`);
  await setSecret(secretName(id), clean);
  const m = await meta();
  m[id] = { account: accountOf(json), connectedAt: Date.now() };
  await storePut(META, JSON.stringify(m));
  return { id, connected: true, account: m[id].account, connectedAt: m[id].connectedAt };
}

export async function disconnect(id: string): Promise<void> {
  const def = connectorDef(id);
  if (!def) throw new Error("unknown connector");
  if (def.kind === "mcp") return removeServer(id);
  if (def.kind !== "token") throw new Error(`${def.name} is set up elsewhere in the dashboard`);
  await forgetSecret(secretName(id));
  const m = await meta();
  delete m[id];
  await storePut(META, JSON.stringify(m));
}

/** Add a catalog MCP connector (GitHub's reuses the GitHub connection's token). */
export async function connectMcp(id: string): Promise<void> {
  const def = connectorDef(id);
  if (!def || def.kind !== "mcp" || !def.mcp) throw new Error("not an MCP connector");
  const token = def.mcp.reuse === "github" ? await githubToken().catch(() => undefined) : undefined;
  if (def.mcp.reuse === "github" && !token) throw new Error("connect GitHub first (Projects page → Connect GitHub)");
  await addServer(id, def.mcp.url, token);
}

/** Every connector's state, for the Customize page and the Assistant. */
export async function connectorStates(): Promise<ConnectorState[]> {
  const [m, gh, servers] = await Promise.all([meta(), githubAuth().catch(() => null), listServers().catch(() => [])]);
  const vms = getVms();
  return CONNECTORS.map((d): ConnectorState => {
    if (d.kind === "token") return m[d.id] ? { id: d.id, connected: true, account: m[d.id].account, connectedAt: m[d.id].connectedAt } : { id: d.id, connected: false };
    if (d.kind === "mcp") {
      const s = servers.find((x) => x.name === d.id);
      return s ? { id: d.id, connected: true, account: s.error ? `error: ${s.error}` : `${s.tools.length} tools`, tools: s.tools.length, connectedAt: s.checkedAt } : { id: d.id, connected: false };
    }
    switch (d.id) {
      case "github":
        return gh ? { id: d.id, connected: true, account: `@${gh.login}`, detail: `${gh.scopes.length} permissions` } : { id: d.id, connected: false, detail: "Connect on the Projects page" };
      case "azure":
        return { id: d.id, connected: aiConfigured(), account: aiConfigured() ? new URL(process.env.AZURE_OPENAI_ENDPOINT!).host : undefined };
      case "machines":
        return { id: d.id, connected: vms.length > 0, account: `${vms.length} machines` };
      case "email":
        return { id: d.id, connected: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS), account: process.env.EMAIL_USER ? process.env.EMAIL_USER.replace(/(.{2}).*(@.*)/, "$1…$2") : undefined };
      case "unsplash":
        return { id: d.id, connected: Boolean(process.env.UNSPLASH_ACCESS_KEY) };
      default:
        return { id: d.id, connected: false };
    }
  });
}

/** The Assistant's call to a connected service. Returns status and (clipped) body. */
export async function callConnector(id: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const def = connectorDef(id);
  if (!def || def.kind !== "token") throw new Error(`no API connector called ${id}`);
  const token = await getSecret(secretName(id));
  if (!token) throw new Error(`${def.name} isn't connected: the user can connect it in Settings → Customize → Connectors`);
  if (!/^\/[A-Za-z0-9._~\-/%?=&,:+@$!*'()]*$/.test(path) || path.includes("..")) throw new Error("path must be an API path starting with /");
  const { url, init } = request(def, token, method.toUpperCase(), path, body);
  const r = await fetch(url, init);
  const text = await r.text();
  // never hand the token back, even if a service echoes it
  return { status: r.status, text: text.split(token).join("••••").slice(0, 30_000) };
}

/** For the system prompt: what's connected and what it can do. */
export async function connectorSummary(): Promise<string> {
  const states = await connectorStates().catch(() => [] as ConnectorState[]);
  const api = states.filter((s) => s.connected && connectorDef(s.id)?.kind === "token");
  if (!api.length) return "";
  return `Connected services (call them with connector_api {connector, method, path, body}; the token is added for you):\n${api
    .map((s) => {
      const d = connectorDef(s.id)!;
      return `- ${d.id} (${d.name}, ${s.account}): ${d.token!.can}. API base ${d.token!.base}`;
    })
    .join("\n")}`;
}
