"use client";

// Pieces of the Assistant's side panel that load their own data: standing instructions, connectors, live
// monitoring of the fleet and the list of tools.
import { Bot, Check, CircleAlert, Cloud, Cpu, Database, Image as ImageIcon, Loader2, Mail, Plug, Search, Server, Sparkles, Wrench, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import { isDestructive } from "@/lib/safety";
import { useCluster } from "./cluster";
import { GithubMark } from "./github";
import { cx } from "./ui";

export interface Overview {
  github: { login: string; scopes: string[]; missing: string[] } | null;
  ai: { configured: boolean; host: string; agent: string; fast: string; vision: string; deployments: { id: string; model: string }[] };
  machines: string[];
  email: boolean;
  unsplash: boolean;
  autopilotReady: boolean;
  tools: { name: string; description: string }[];
}

let overviewCache: Promise<Overview> | null = null;
export function useOverview(): Overview | null {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => {
    let alive = true;
    overviewCache ??= api<Overview>("/api/assistant/overview").catch((e) => {
      overviewCache = null;
      throw e;
    });
    overviewCache.then((x) => alive && setO(x), () => {});
    return () => {
      alive = false;
    };
  }, []);
  return o;
}

/* ---------- instructions ---------- */

export function InstructionsEditor() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [max, setMax] = useState(8000);
  useEffect(() => {
    api<{ text: string; max: number }>("/api/assistant/instructions").then(
      (r) => {
        setText(r.text);
        setSaved(r.text);
        setMax(r.max);
      },
      () => setText(""),
    );
  }, []);
  if (text === null) return <p className="text-xs text-muted">Loading…</p>;
  const dirty = text !== saved;
  const save = async () => {
    setState("saving");
    try {
      const r = await api<{ text: string }>("/api/assistant/instructions", { text });
      setSaved(r.text);
      setText(r.text);
      setState("saved");
      setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("error");
    }
  };
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, max))}
        rows={6}
        placeholder={"How the Assistant should work, in every chat. For example:\n· Deploy Java apps on box3\n· Always use Postgres for new apps\n· Reply in short bullet points"}
        className="scroll-thin w-full resize-y rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-xs leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:border-white/20"
      />
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-zinc-600">
          {text.length}/{max}
        </span>
        <span className="flex-1" />
        {state === "saved" && (
          <span className="flex items-center gap-1 text-[var(--good)]">
            <Check className="size-3" /> Saved
          </span>
        )}
        {state === "error" && <span className="text-[var(--critical-text)]">Couldn&apos;t save</span>}
        <button onClick={() => void save()} disabled={!dirty || state === "saving"} className="rounded-md bg-white px-2.5 py-1 font-medium text-black hover:bg-white/90 disabled:bg-white/[0.08] disabled:text-zinc-500">
          {state === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/* ---------- connectors ---------- */

function Row({ icon: Icon, name, sub, ok, children }: { icon: LucideIcon | typeof GithubMark; name: string; sub: ReactNode; ok: boolean | null; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.06] text-zinc-300">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-white">{name}</p>
          <p className="truncate text-[11px] text-zinc-500">{sub}</p>
        </div>
        {ok === null ? null : ok ? <span className="size-1.5 rounded-full bg-[var(--good)]" title="Connected" /> : <span className="size-1.5 rounded-full bg-zinc-600" title="Not set up" />}
      </div>
      {children}
    </div>
  );
}

export function Connectors({ mcp }: { mcp?: ReactNode }) {
  const o = useOverview();
  const { vms, status } = useCluster();
  if (!o) return <p className="text-xs text-muted">Loading…</p>;
  const online = vms.filter((v) => status[v.name]?.ok).length;
  return (
    <div className="space-y-2">
      <Row icon={GithubMark} name="GitHub" sub={o.github ? `@${o.github.login} · ${o.github.scopes.length} permissions${o.github.missing.length ? ` · missing ${o.github.missing.join(", ")}` : ""}` : "Not connected · Projects page → Connect GitHub"} ok={Boolean(o.github)} />
      <Row icon={Bot} name="Azure OpenAI" sub={o.ai.configured ? `${o.ai.host} · ${o.ai.deployments.length} models · agent ${o.ai.agent}` : "Not configured"} ok={o.ai.configured}>
        {o.ai.deployments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {o.ai.deployments.map((d) => (
              <span key={d.id} className={cx("rounded px-1.5 py-0.5 font-mono text-[10px]", d.id === o.ai.agent ? "bg-[var(--accent)]/20 text-white" : "bg-white/[0.05] text-zinc-400")} title={d.model}>
                {d.id}
              </span>
            ))}
          </div>
        )}
      </Row>
      <Row icon={Server} name="Machines (SSH)" sub={`${online}/${vms.length} online · ${vms.map((v) => v.name).join(", ")}`} ok={online > 0} />
      <Row icon={Sparkles} name="skills-hub.ai" sub="Community skills: search, install (you approve), load" ok={true} />
      <Row icon={ImageIcon} name="Screenshots & vision" sub={`Headless Chrome on a machine · vision model ${o.ai.vision}`} ok={o.ai.configured} />
      <Row icon={Mail} name="Email alerts" sub={o.email ? "Autopilot emails what it fixed" : "Set EMAIL_USER and EMAIL_PASS"} ok={o.email} />
      <Row icon={Cloud} name="Unsplash" sub={o.unsplash ? "Daily cover photos and colors" : "Set UNSPLASH_ACCESS_KEY"} ok={o.unsplash} />
      {mcp}
      <McpConnectors />
    </div>
  );
}

/* ---------- MCP connectors ---------- */

interface McpInfo {
  name: string;
  url: string;
  enabled: boolean;
  tools: { name: string; description: string; readOnly?: boolean; destructive?: boolean }[];
  checkedAt?: number;
  error?: string;
  hasToken: boolean;
}
interface McpList {
  servers: McpInfo[];
  suggestions: { name: string; url: string; about: string; token?: string }[];
}

export function McpConnectors() {
  const [d, setD] = useState<McpList | null>(null);
  const [form, setForm] = useState<{ name: string; url: string; token: string; needsToken?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api<McpList>("/api/mcp").then(setD, () => setD({ servers: [], suggestions: [] }));
  }, []);
  const act = async (key: string, body: unknown) => {
    setBusy(key);
    setErr(null);
    try {
      setD(await api<McpList>("/api/mcp", body));
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  if (!d) return null;
  const have = new Set(d.servers.map((x) => x.name));
  return (
    <div className="mt-4 space-y-2">
      <p className="flex items-center gap-1.5 pt-2 text-[11px] font-medium text-zinc-400">
        <Plug className="size-3" /> MCP servers
        <span className="font-normal text-zinc-600">· tools from other services the Assistant can use</span>
      </p>
      {d.servers.map((m) => (
        <div key={m.name} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.06] text-zinc-300">
              <Plug className="size-3.5" />
            </span>
            <button onClick={() => setOpen(open === m.name ? null : m.name)} className="min-w-0 flex-1 text-left">
              <p className="truncate text-xs font-medium text-white">{m.name}</p>
              <p className="truncate text-[11px] text-zinc-500">{m.error ? m.error : `${m.tools.length} tools · ${m.url.replace(/^https:\/\//, "")}${m.hasToken ? " · token" : ""}`}</p>
            </button>
            <button
              role="switch"
              aria-checked={m.enabled}
              onClick={() => void act(`en-${m.name}`, { enable: m.name, on: !m.enabled })}
              className={cx("relative h-4 w-7 shrink-0 rounded-full transition-colors", m.enabled ? "bg-[var(--accent)]" : "bg-white/15")}
              title={m.enabled ? "On" : "Off"}
            >
              <span className={cx("absolute top-0.5 size-3 rounded-full bg-white transition-all", m.enabled ? "left-[14px]" : "left-0.5")} />
            </button>
          </div>
          {open === m.name && (
            <div className="mt-2 space-y-1 border-t border-white/[0.05] pt-2">
              {m.tools.slice(0, 40).map((t) => (
                <p key={t.name} className="truncate text-[11px] text-zinc-400" title={t.description}>
                  <span className="font-mono text-zinc-200">{t.name}</span> {t.destructive ? <span className="text-[var(--warning)]">· changes things</span> : t.readOnly ? <span className="text-zinc-600">· read-only</span> : null}
                </p>
              ))}
              <div className="flex gap-3 pt-1 text-[11px]">
                <button onClick={() => void act(`rf-${m.name}`, { refresh: m.name })} className="text-accent-soft hover:text-white">
                  {busy === `rf-${m.name}` ? "Checking…" : "Refresh tools"}
                </button>
                <button onClick={() => void act(`rm-${m.name}`, { remove: m.name })} className="text-zinc-500 hover:text-[var(--critical-text)]">
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {form ? (
        <div className="space-y-1.5 rounded-lg border border-white/[0.08] bg-black/30 p-2.5">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="name (e.g. context7)" className="w-full rounded-md bg-white/[0.04] px-2 py-1.5 text-xs text-white placeholder:text-zinc-600" />
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value.trim() })} placeholder="https://… (Streamable HTTP endpoint)" className="w-full rounded-md bg-white/[0.04] px-2 py-1.5 font-mono text-[11px] text-white placeholder:text-zinc-600" />
          <input
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
            type="password"
            autoComplete="off"
            placeholder={form.needsToken ? `Token: ${form.needsToken}` : "Token (optional, stored encrypted)"}
            className="w-full rounded-md bg-white/[0.04] px-2 py-1.5 text-xs text-white placeholder:text-zinc-600"
          />
          <div className="flex justify-end gap-2 pt-0.5 text-xs">
            <button onClick={() => setForm(null)} className="rounded-md px-2.5 py-1 text-zinc-400 hover:text-white">
              Cancel
            </button>
            <button
              disabled={!form.name || !form.url || busy === "add"}
              onClick={async () => {
                if (await act("add", { add: { name: form.name, url: form.url, token: form.token } })) setForm(null);
              }}
              className="flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 font-medium text-black hover:bg-white/90 disabled:bg-white/[0.08] disabled:text-zinc-500"
            >
              {busy === "add" && <Loader2 className="size-3 animate-spin" />} Connect
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setForm({ name: "", url: "", token: "" })} className="w-full rounded-lg border border-dashed border-white/10 px-3 py-2 text-xs text-zinc-400 hover:border-white/25 hover:text-white">
          + Add an MCP server
        </button>
      )}
      {err && <p className="text-[11px] text-[var(--critical-text)]">{err}</p>}

      {d.suggestions.filter((x) => !have.has(x.name)).length > 0 && (
        <div className="space-y-1 pt-1">
          <p className="text-[10.5px] text-zinc-600">Popular remote servers</p>
          {d.suggestions
            .filter((x) => !have.has(x.name))
            .map((x) => (
              <button
                key={x.name}
                onClick={() => (x.token ? setForm({ name: x.name, url: x.url, token: "", needsToken: x.token }) : void act(`add-${x.name}`, { add: { name: x.name, url: x.url } }))}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.04]"
              >
                {busy === `add-${x.name}` ? <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-zinc-400" /> : <Plug className="mt-0.5 size-3 shrink-0 text-zinc-500" />}
                <span className="min-w-0">
                  <span className="block text-xs text-zinc-200">{x.name}</span>
                  <span className="block text-[11px] leading-snug text-zinc-500">{x.about}{x.token ? " · needs a token" : ""}</span>
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/* ---------- monitor ---------- */

function Bar({ pct, warn = 80 }: { pct: number; warn?: number }) {
  return (
    <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
      <span className={cx("block h-full rounded-full", pct >= warn ? "bg-[var(--warning)]" : "bg-[var(--accent)]")} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
    </span>
  );
}

export function Monitor() {
  const { vms, status, checking, openJob } = useCluster();
  const [store, setStore] = useState<{ vm: string; ok: boolean; until: string | null; copy: { vm: string; at: number } | null } | null>(null);
  const loadStore = useCallback(() => api<typeof store>("/api/storage").then(setStore, () => {}), []);
  useEffect(() => {
    void loadStore();
    const t = setInterval(() => void loadStore(), 60_000);
    return () => clearInterval(t);
  }, [loadStore]);
  const jobs = useMemo(
    () => vms.flatMap((v) => (status[v.name]?.agent?.jobs ?? []).filter((j) => j.state === "running").map((j) => ({ vm: v.name, id: j.id, label: j.meta.label ?? j.meta.kind }))),
    [vms, status],
  );
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {vms.map((v) => {
          const s = status[v.name];
          const a = s?.agent;
          const cpu = a?.cpuPct ?? 0;
          const mem = a && a.memTotalKb ? Math.round(((a.memTotalKb - a.memAvailKb) / a.memTotalKb) * 100) : 0;
          const disk = a && a.diskTotalKb ? Math.round((a.diskUsedKb / a.diskTotalKb) * 100) : 0;
          return (
            <div key={v.name} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className={cx("size-1.5 rounded-full", checking[v.name] && !s ? "animate-pulse bg-zinc-500" : s?.ok ? "bg-[var(--good)]" : "bg-[var(--critical)]")} />
                <span className="font-mono text-white">{v.name}</span>
                <span className="ml-auto truncate text-[10.5px] text-zinc-500">{s?.ok ? `${a?.projects.length ?? 0} projects` : s?.error?.match(/cooling down until ([\d:T-]+)/) ? "cooling down" : s ? "unreachable" : "checking…"}</span>
              </div>
              {s?.ok && a && (
                <div className="mt-1.5 grid grid-cols-[34px_1fr_30px] items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
                  <span>CPU</span>
                  <Bar pct={cpu} />
                  <span className="text-right tabular-nums">{cpu}%</span>
                  <span>RAM</span>
                  <Bar pct={mem} warn={90} />
                  <span className="text-right tabular-nums">{mem}%</span>
                  <span>Disk</span>
                  <Bar pct={disk} warn={85} />
                  <span className="text-right tabular-nums">{disk}%</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
          <Cpu className="size-3" /> Running jobs
        </p>
        {jobs.length === 0 ? (
          <p className="text-xs text-zinc-600">Nothing running.</p>
        ) : (
          jobs.map((j) => (
            <button key={`${j.vm}-${j.id}`} onClick={() => openJob({ vm: j.vm, id: j.id, title: j.label })} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink hover:bg-white/5">
              <Loader2 className="size-3 shrink-0 animate-spin text-[var(--accent)]" />
              <span className="flex-1 truncate">{j.label}</span>
              <span className="font-mono text-[10.5px] text-zinc-500">{j.vm}</span>
            </button>
          ))
        )}
      </div>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
          <Database className="size-3" /> Dashboard data
        </p>
        {!store ? (
          <p className="text-xs text-zinc-600">Checking…</p>
        ) : (
          <div className="space-y-1 text-xs">
            <p className="flex items-center gap-1.5 text-ink">
              {store.ok ? <Check className="size-3 text-[var(--good)]" /> : <CircleAlert className="size-3 text-[var(--warning)]" />} Stored on <span className="font-mono">{store.vm}</span>
              {!store.ok && <span className="text-zinc-500">{store.until ? `· resting until ${new Date(store.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "· unreachable"}</span>}
            </p>
            <p className="text-[11px] text-zinc-500">
              {store.copy ? `Copy on ${store.copy.vm}, made ${timeAgo(store.copy.at)}` : "No copy on a second machine yet (Autopilot makes one every 15 min)"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- tools ---------- */

const GROUPS: [string, RegExp][] = [
  ["Machines & projects", /fleet|run_command|job|deploy|project|move|machine|schedule|task|tunnel|link_databases|connect/],
  ["Services", /service|n8n|db_query|import_zip/],
  ["Code & GitHub", /repo|github/],
  ["Look & verify", /screenshot|diagram|artifact|plan/],
  ["Knowledge", /skill|remember|forget|attachment|ask_user/],
];

export function ToolsList() {
  const o = useOverview();
  const [q, setQ] = useState("");
  if (!o) return <p className="text-xs text-muted">Loading…</p>;
  const shown = o.tools.filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase()));
  const grouped = GROUPS.map(([g, re]) => [g, shown.filter((t) => re.test(t.name))] as const);
  const rest = shown.filter((t) => !GROUPS.some(([, re]) => re.test(t.name)));
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/30 px-2.5 py-1.5">
        <Search className="size-3.5 text-zinc-500" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${o.tools.length} tools`} className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-zinc-600" />
        {q && (
          <button onClick={() => setQ("")} aria-label="Clear">
            <X className="size-3 text-zinc-500" />
          </button>
        )}
      </label>
      {[...grouped, ["Other", rest] as const].map(([g, list]) =>
        list.length ? (
          <div key={g}>
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Wrench className="size-3" /> {g}
            </p>
            {list.map((t) => (
              <details key={t.name} className="group rounded-md px-2 py-1 text-xs hover:bg-white/[0.03]">
                <summary className="cursor-pointer list-none font-mono text-[11.5px] text-zinc-200">{t.name}</summary>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{t.description}</p>
              </details>
            ))}
          </div>
        ) : null,
      )}
    </div>
  );
}


/* ---------- memory, skills, autopilot (self-loading, used by Settings) ---------- */

export function MemoryList() {
  const [memory, setMemory] = useState<{ id: string; text: string }[] | null>(null);
  useEffect(() => {
    api<{ memory: { id: string; text: string }[] }>("/api/memory").then((r) => setMemory(r.memory), () => setMemory([]));
  }, []);
  if (memory === null) return <p className="text-xs text-muted">Loading…</p>;
  if (!memory.length) return <p className="text-xs text-muted">Nothing yet. Tell the Assistant a preference (&quot;deploy Java apps on box3&quot;) and it remembers it in every chat; lessons it learns show up here too.</p>;
  return (
    <div className="space-y-1">
      {memory.map((m) => (
        <div key={m.id} className="group flex items-start gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2 text-xs text-zinc-200">
          <span className="flex-1 leading-relaxed">{m.text}</span>
          <button
            onClick={() => void api<{ memory: { id: string; text: string }[] }>("/api/memory", { remove: m.id }).then((r) => setMemory(r.memory))}
            className="shrink-0 text-zinc-600 opacity-0 hover:text-[var(--critical-text)] group-hover:opacity-100"
            aria-label="Forget"
            title="Forget"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

type SkillList = {
  builtIn: { id: string; title: string }[];
  installed: { slug: string; name: string; description: string; author: string; aiVerdict: string | null }[];
};

export function SkillsList() {
  const [skills, setSkills] = useState<SkillList | null>(null);
  useEffect(() => {
    api<SkillList>("/api/skills").then(setSkills, () => setSkills({ builtIn: [], installed: [] }));
  }, []);
  if (!skills) return <p className="text-xs text-muted">Loading…</p>;
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-zinc-400">Built in ({skills.builtIn.length})</p>
        <div className="flex flex-wrap gap-1.5">
          {skills.builtIn.map((b) => (
            <span key={b.id} className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11.5px] text-zinc-300">
              {b.title.split(/[:(]/)[0].trim()}
            </span>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-zinc-400">From skills-hub.ai ({skills.installed.length})</p>
        {skills.installed.length === 0 ? (
          <p className="text-xs text-muted">Ask for anything specialised and the Assistant finds a skill on skills-hub.ai (you approve installs).</p>
        ) : (
          skills.installed.map((h) => (
            <div key={h.slug} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-white/[0.03]" title={h.description}>
              <a href={`https://skills-hub.ai/skills/${h.slug}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
                <span className="block truncate text-zinc-200 hover:underline">{h.name}</span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {h.author || "unknown"}
                  {h.aiVerdict ? ` · security review ${h.aiVerdict}` : ""} · {h.description}
                </span>
              </a>
              <button onClick={() => void api<SkillList>("/api/skills", { remove: h.slug }).then(setSkills)} className="shrink-0 text-zinc-600 opacity-0 hover:text-[var(--critical-text)] group-hover:opacity-100" aria-label="Remove skill">
                <X className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function AutopilotSettings() {
  const [a, setA] = useState<{ enabled: boolean; lastRun?: number; lastSummary?: string; sessionId?: string; canEnable?: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(() => api<NonNullable<typeof a>>("/api/autopilot").then(setA, () => setA(null)), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!a) return <p className="text-xs text-muted">Loading…</p>;
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-xs text-zinc-200">
        <span>
          Check and fix the fleet every 15 minutes
          <span className="block text-[11px] text-zinc-500">Restarts crashed services and tunnels, clears full disks, keeps a copy of the dashboard&apos;s data, moves apps off machines that stay down, and asks the Assistant to fix the rest.</span>
        </span>
        <button
          role="switch"
          aria-checked={a.enabled}
          disabled={!a.canEnable}
          onClick={async () => {
            setErr(null);
            try {
              const r = await api<NonNullable<typeof a>>("/api/autopilot", { enabled: !a.enabled });
              setA({ ...a, ...r });
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
          className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40", a.enabled ? "bg-[var(--accent)]" : "bg-white/15")}
        >
          <span className={cx("absolute top-0.5 size-4 rounded-full bg-white transition-all", a.enabled ? "left-[18px]" : "left-0.5")} />
        </button>
      </label>
      {!a.canEnable && <p className="text-[11px] text-muted">Needs CRON_SECRET in the environment.</p>}
      {err && <p className="text-[11px] text-[var(--critical-text)]">{err}</p>}
      {a.lastRun ? (
        <p className="text-xs text-zinc-400">
          Last check {timeAgo(a.lastRun)}: <span className="text-zinc-300">{(a.lastSummary ?? "").split("\n")[0]}</span>
        </p>
      ) : null}
      <button
        onClick={async () => {
          setChecking(true);
          await api("/api/autopilot", { run: true }).catch(() => null);
          setTimeout(() => {
            void load();
            setChecking(false);
          }, 25_000);
        }}
        disabled={checking}
        className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-200 hover:bg-white/[0.05] disabled:opacity-60"
      >
        {checking && <Loader2 className="size-3 animate-spin" />} {checking ? "Checking…" : "Check now"}
      </button>
    </div>
  );
}

/* ---------- terminal ---------- */

interface Line {
  id: number;
  vm: string;
  cmd: string;
  out?: string;
  code?: number | null;
  running: boolean;
}
let lineId = 1;

/** A small shell next to the conversation: run a command on one machine (or all), see the output. */
export function TerminalPanel() {
  const { vms, status, exec } = useCluster();
  const online = vms.filter((v) => status[v.name]?.ok).map((v) => v.name);
  const [vm, setVm] = useState<string>("");
  const target = vm || online[0] || vms[0]?.name || "";
  const [cmd, setCmd] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const run = async () => {
    const c = cmd.trim();
    if (!c || !target) return;
    if (/^(clear|cls)$/.test(c)) {
      setLines([]);
      setCmd("");
      return;
    }
    if (isDestructive(c) && !confirm(`This command can destroy data:\n\n${c}\n\nRun it on ${target === "*" ? "every online machine" : target}?`)) return;
    setHist((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHi(-1);
    setCmd("");
    const targets = target === "*" ? online : [target];
    const ids = targets.map((t) => ({ t, id: lineId++ }));
    setLines((l) => [...l, ...ids.map(({ t, id }) => ({ id, vm: t, cmd: c, running: true }))].slice(-80));
    await exec(targets, c, (r) => {
      const id = ids.find((x) => x.t === r.vm)?.id;
      setLines((l) => l.map((x) => (x.id === id ? { ...x, running: false, code: r.code, out: `${r.stdout}${r.stderr ? `${r.stdout ? "\n" : ""}${r.stderr}` : ""}${r.error ? r.error : ""}`.trimEnd() } : x)));
    });
  };

  return (
    <div className="-m-4 flex h-[calc(100%+2rem)] flex-col bg-term">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <select value={target} onChange={(e) => setVm(e.target.value)} className="h-7 rounded-md border border-white/10 bg-panel-2 px-2 font-mono text-[12px] text-zinc-200">
          {vms.map((v) => (
            <option key={v.name} value={v.name} disabled={!status[v.name]?.ok}>
              {v.name}
              {status[v.name]?.ok ? "" : " (resting)"}
            </option>
          ))}
          {online.length > 1 && <option value="*">all online ({online.length})</option>}
        </select>
        <span className="flex-1" />
        <button onClick={() => setLines([])} className="text-[11px] text-zinc-500 hover:text-white">
          Clear
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed" onClick={() => document.getElementById("term-input")?.focus()}>
        {lines.length === 0 && <p className="text-zinc-600">Connected to {online.length} of {vms.length} machines. Type a command and press Enter.</p>}
        {lines.map((l) => (
          <div key={l.id} className="mb-2">
            <p className="text-zinc-300">
              <span className="text-[var(--accent)]">user@{l.vm}</span>
              <span className="text-zinc-600">:~$ </span>
              {l.cmd}
            </p>
            {l.running ? (
              <p className="flex items-center gap-1.5 text-zinc-600">
                <Loader2 className="size-3 animate-spin" /> running…
              </p>
            ) : (
              <pre className={cx("break-all whitespace-pre-wrap", l.code ? "text-[var(--critical-text)]" : "text-zinc-400")}>{l.out || (l.code ? `exit ${l.code}` : "")}</pre>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2 font-mono text-[12px]">
        <span className="shrink-0 text-[var(--accent)]">{target === "*" ? "all" : target}</span>
        <span className="text-zinc-600">$</span>
        <input
          id="term-input"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            } else if (e.key === "ArrowUp" && hist.length) {
              e.preventDefault();
              const n = Math.min(hi + 1, hist.length - 1);
              setHi(n);
              setCmd(hist[n]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const n = hi - 1;
              setHi(Math.max(n, -1));
              setCmd(n >= 0 ? hist[n] : "");
            }
          }}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-zinc-100 placeholder:text-zinc-700"
          placeholder="uptime"
        />
      </div>
    </div>
  );
}
