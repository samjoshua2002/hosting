"use client";

// Pieces of the Assistant's side panel that load their own data: standing instructions, connectors, live
// monitoring of the fleet and the list of tools.
import { Bot, Check, CircleAlert, Cloud, Cpu, Database, Image as ImageIcon, Loader2, Mail, Search, Server, Sparkles, Wrench, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";
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

