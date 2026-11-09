"use client";

// Settings → Customize, like Claude's: Connectors / Skills / MCP, each with Yours and Discover, search and Add.
import { Check, ChevronDown, ExternalLink, Loader2, MoreHorizontal, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { CONNECTOR_CATEGORIES, CONNECTORS, type ConnectorDef } from "@/lib/connector-catalog";
import { McpConnectors } from "./assistant-panel";
import { cx } from "./ui";

interface State {
  id: string;
  connected: boolean;
  account?: string;
  detail?: string;
  connectedAt?: number;
  tools?: number;
}

/** A brand logo (Simple Icons), falling back to a lettered tile. */
export function Logo({ def, size = 44 }: { def: Pick<ConnectorDef, "name" | "logo">; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (def.logo.slug === "langfuse") {
    return (
      <span className="grid shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-panel-2 text-white" style={{ width: size, height: size }}>
        <svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18" />
          <path d="m3 12 18 0" />
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          <path d="m5 5 14 14" />
          <path d="m19 5-14 14" />
        </svg>
      </span>
    );
  }
  return (
    <span className="grid shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-panel-2" style={{ width: size, height: size }}>
      {broken ? (
        <span className="text-[15px] font-semibold text-zinc-300">{def.name[0]}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://cdn.simpleicons.org/${def.logo.slug}/${def.logo.color}`}
          alt=""
          width={size * 0.5}
          height={size * 0.5}
          onError={() => setBroken(true)}
          className={def.logo.color.toLowerCase() === "ffffff" ? "logo-mono" : undefined}
        />
      )}
    </span>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg bg-white/[0.04] p-0.5">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={cx("rounded-md px-3 py-1 text-[13px] transition-colors", value === v ? "bg-white/[0.1] text-white" : "text-zinc-400 hover:text-white")}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Customize() {
  const [tab, setTab] = useState<"connectors" | "skills" | "mcp">("connectors");
  const [scope, setScope] = useState<"yours" | "discover">("discover");
  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-0.5">
          {(
            [
              ["connectors", "Connectors"],
              ["skills", "Skills"],
              ["mcp", "MCP"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} onClick={() => setTab(v)} className={cx("rounded-lg px-3 py-1.5 text-[13.5px] transition-colors", tab === v ? "bg-white/[0.09] text-white" : "text-zinc-400 hover:text-white")}>
              {label}
            </button>
          ))}
        </div>
        <span className="h-5 w-px bg-white/[0.08]" />
        {tab !== "mcp" && (
          <Seg
            value={scope}
            options={[
              ["yours", "Yours"],
              ["discover", "Discover"],
            ]}
            onChange={setScope}
          />
        )}
        <label className="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5">
          <Search className="size-3.5 text-zinc-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-zinc-600" />
        </label>
        <div className="relative">
          <button onClick={() => setAddOpen((o) => !o)} className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[13px] font-medium text-black hover:bg-white/90">
            <Plus className="size-3.5" /> Add <ChevronDown className="size-3.5" />
          </button>
          {addOpen && (
            <>
              <button className="fixed inset-0 z-30 cursor-default" aria-label="Close" onClick={() => setAddOpen(false)} />
              <div className="absolute top-10 right-0 z-40 w-60 overflow-hidden rounded-xl border border-white/[0.09] bg-pop py-1.5 shadow-2xl shadow-black/60">
                {(
                  [
                    ["Connector from the catalog", () => (setTab("connectors"), setScope("discover"))],
                    ["Skill from skills-hub.ai", () => (setTab("skills"), setScope("discover"))],
                    ["Custom MCP server…", () => setTab("mcp")],
                  ] as [string, () => void][]
                ).map(([label, go]) => (
                  <button
                    key={label}
                    onClick={() => {
                      go();
                      setAddOpen(false);
                    }}
                    className="block w-full px-3.5 py-2 text-left text-[13px] text-zinc-200 hover:bg-white/[0.06]"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-6">
        {tab === "connectors" && <ConnectorsView scope={scope} q={q} onDiscover={() => setScope("discover")} />}
        {tab === "skills" && <SkillsView scope={scope} q={q} />}
        {tab === "mcp" && (
          <div className="max-w-2xl">
            <p className="mb-3 text-sm text-zinc-400">Any remote MCP server (Streamable HTTP). Its tools become the Assistant&apos;s; anything that changes things outside this platform asks first.</p>
            <McpConnectors />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- connectors ---------------- */

function ConnectorsView({ scope, q, onDiscover }: { scope: "yours" | "discover"; q: string; onDiscover: () => void }) {
  const [states, setStates] = useState<State[] | null>(null);
  const [cat, setCat] = useState<string>("All");
  const [connecting, setConnecting] = useState<ConnectorDef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<{ states: State[] }>("/api/connectors").then((r) => setStates(r.states), (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const byId = useMemo(() => new Map((states ?? []).map((s) => [s.id, s])), [states]);
  const match = (d: ConnectorDef) => !q || `${d.name} ${d.desc} ${d.by} ${d.category}`.toLowerCase().includes(q.toLowerCase());
  const list = CONNECTORS.filter((d) => match(d) && (scope === "yours" ? byId.get(d.id)?.connected : true) && (cat === "All" || d.category === cat));
  const act = async (key: string, body: unknown) => {
    setBusy(key);
    setErr(null);
    try {
      setStates((await api<{ states: State[] }>("/api/connectors", body)).states);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  if (!states) return <p className="flex items-center gap-2 text-sm text-zinc-500">{err ?? <><Loader2 className="size-4 animate-spin" /> Loading connectors…</>}</p>;
  const connectedCount = states.filter((s) => s.connected).length;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <p className="mr-2 text-[15px] font-medium text-white">
          {scope === "yours" ? "Connected" : "Connectors"} <span className="ml-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11.5px] text-zinc-400">{scope === "yours" ? connectedCount : CONNECTORS.length}</span>
        </p>
        <span className="flex-1" />
        <SlidersHorizontal className="size-3.5 text-zinc-600" />
        {["All", ...CONNECTOR_CATEGORIES].map((c) => (
          <button key={c} onClick={() => setCat(c)} className={cx("rounded-md px-2 py-0.5 text-[12px] transition-colors", cat === c ? "bg-white/[0.09] text-white" : "text-zinc-500 hover:text-zinc-200")}>
            {c}
          </button>
        ))}
      </div>
      {err && <p className="mb-3 text-[12.5px] text-[var(--critical-text)]">{err}</p>}
      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 px-6 py-12 text-center">
          <p className="text-sm text-zinc-300">{scope === "yours" ? "Nothing connected in this view yet." : "No connectors match."}</p>
          {scope === "yours" && (
            <button onClick={onDiscover} className="mt-3 text-[13px] text-accent-soft hover:underline">
              Discover connectors →
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {list.map((d) => {
            const s = byId.get(d.id);
            return (
              <div key={d.id} className="group flex gap-3.5 rounded-xl border border-white/[0.06] bg-panel p-4 transition-colors hover:border-white/[0.12]">
                <Logo def={d} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[14.5px] font-medium text-white">
                    {d.name}
                    {d.kind === "mcp" && <span className="rounded border border-white/10 px-1 text-[9.5px] font-normal tracking-wide text-zinc-500 uppercase">MCP</span>}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-zinc-400">{d.desc}</p>
                  <p className="mt-1.5 truncate text-[11.5px] text-zinc-600">
                    {s?.connected ? (
                      <span className="text-[var(--good)]">
                        ● Connected{s.account ? <span className="text-zinc-400"> · {s.account}</span> : null}
                        {s.detail ? <span className="text-zinc-500"> · {s.detail}</span> : null}
                      </span>
                    ) : (
                      <>by {d.by}{d.kind === "builtin" && s?.detail ? ` · ${s.detail}` : ""}</>
                    )}
                  </p>
                </div>
                <ConnectorAction def={d} s={s} busy={busy === d.id} onConnect={() => (d.kind === "token" ? setConnecting(d) : void act(d.id, { mcp: d.id }))} onDisconnect={() => void act(d.id, { disconnect: d.id })} />
              </div>
            );
          })}
        </div>
      )}
      {connecting && (
        <ConnectDialog
          def={connecting}
          onClose={() => setConnecting(null)}
          onDone={(st) => {
            setStates(st);
            setConnecting(null);
          }}
        />
      )}
    </div>
  );
}

function ConnectorAction({ def, s, busy, onConnect, onDisconnect }: { def: ConnectorDef; s?: State; busy: boolean; onConnect: () => void; onDisconnect: () => void }) {
  const [menu, setMenu] = useState(false);
  if (busy) return <Loader2 className="size-4 shrink-0 animate-spin text-zinc-500" />;
  if (def.kind === "builtin") {
    if (def.id === "langfuse" && s?.connected) {
      return (
        <a
          href={s.account ? `https://${s.account}` : "https://cloud.langfuse.com"}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 h-7 shrink-0 rounded-lg border border-white/10 px-2 text-[11.5px] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
        >
          <Check className="size-3.5 text-[var(--good)]" /> Open <ExternalLink className="size-3 opacity-60" />
        </a>
      );
    }
    if (s?.connected) return <Check className="size-4 shrink-0 text-[var(--good)]" />;
    return def.id === "github" ? (
      <Link href="/projects" className="h-8 shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-zinc-200 hover:bg-white/[0.06]">
        Connect
      </Link>
    ) : (
      <span className="shrink-0 text-[11px] text-zinc-600 font-mono">.env</span>
    );
  }
  if (s?.connected)
    return (
      <div className="relative shrink-0">
        <button onClick={() => setMenu((m) => !m)} className="grid size-8 place-items-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white" aria-label="Options">
          <MoreHorizontal className="size-4" />
        </button>
        {menu && (
          <>
            <button className="fixed inset-0 z-30 cursor-default" aria-label="Close" onClick={() => setMenu(false)} />
            <div className="absolute top-9 right-0 z-40 w-40 overflow-hidden rounded-lg border border-white/[0.09] bg-pop py-1 shadow-xl">
              {def.kind === "token" && (
                <button
                  onClick={() => {
                    setMenu(false);
                    onConnect();
                  }}
                  className="block w-full px-3 py-1.5 text-left text-[12.5px] text-zinc-200 hover:bg-white/[0.06]"
                >
                  Replace token
                </button>
              )}
              <button
                onClick={() => {
                  setMenu(false);
                  onDisconnect();
                }}
                className="block w-full px-3 py-1.5 text-left text-[12.5px] text-[var(--critical-text)] hover:bg-white/[0.06]"
              >
                Disconnect
              </button>
            </div>
          </>
        )}
      </div>
    );
  return (
    <button onClick={onConnect} className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/10 text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.06] hover:text-white" aria-label={`Connect ${def.name}`} title={`Connect ${def.name}`}>
      <Plus className="size-4" />
    </button>
  );
}

function ConnectDialog({ def, onClose, onDone }: { def: ConnectorDef; onClose: () => void; onDone: (s: State[]) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = def.token!;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone((await api<{ states: State[] }>("/api/connectors", { connect: { id: def.id, token } })).states);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className="w-[480px] max-w-[92vw] rounded-2xl border border-white/[0.09] bg-pop p-6 shadow-2xl shadow-black/70" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3.5">
          <Logo def={def} />
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold text-white">Connect {def.name}</p>
            <p className="mt-0.5 text-[12.5px] text-zinc-400">{def.desc}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-5 rounded-xl border border-white/[0.06] bg-black/20 p-3.5 text-[12.5px] leading-relaxed text-zinc-400">
          <p className="text-zinc-300">The Assistant will be able to: {t.can}.</p>
          <p className="mt-1.5">Anything that changes something on {def.name} asks you first. The token is checked with {def.name}, then stored encrypted; the AI never sees it.</p>
        </div>
        <label className="mt-4 block text-[12.5px] text-zinc-300">
          {t.label}
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && token && void submit()}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[13px] text-white focus:border-white/25"
            placeholder="Paste it here"
          />
        </label>
        <a href={t.help} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] text-accent-soft hover:underline">
          Where do I get one? <ExternalLink className="size-3" />
        </a>
        {err && <p className="mt-3 text-[12.5px] text-[var(--critical-text)]">{err}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-zinc-300 hover:bg-white/[0.06]">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={!token || busy} className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-[13px] font-medium text-black hover:bg-white/90 disabled:bg-white/[0.08] disabled:text-zinc-500">
            {busy && <Loader2 className="size-3.5 animate-spin" />} {busy ? "Checking…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- skills ---------------- */

interface HubResult {
  slug: string;
  name: string;
  description: string;
  author: string;
  trusted: boolean;
  securityGrade: string | null;
  aiVerdict: string | null;
  installs: number;
}
interface SkillList {
  builtIn: { id: string; title: string }[];
  installed: { slug: string; name: string; description: string; author: string; aiVerdict: string | null }[];
}

function SkillsView({ scope, q }: { scope: "yours" | "discover"; q: string }) {
  const [mine, setMine] = useState<SkillList | null>(null);
  const [hub, setHub] = useState<HubResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<SkillList>("/api/skills").then(setMine, () => setMine({ builtIn: [], installed: [] }));
  }, []);
  useEffect(() => {
    if (scope !== "discover") return;
    let alive = true;
    const t = setTimeout(() => {
      setHub(null);
      api<{ results: HubResult[] }>(`/api/skills?q=${encodeURIComponent(q || "deploy")}`).then(
        (r) => alive && setHub(r.results),
        () => alive && setHub([]),
      );
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [scope, q]);
  const installed = new Set((mine?.installed ?? []).map((x) => x.slug));
  const act = async (key: string, body: unknown) => {
    setBusy(key);
    setErr(null);
    try {
      setMine(await api<SkillList>("/api/skills", body));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (scope === "yours") {
    if (!mine) return <p className="text-sm text-zinc-500">Loading…</p>;
    const m = (t: string) => !q || t.toLowerCase().includes(q.toLowerCase());
    return (
      <div className="space-y-6">
        <div>
          <p className="mb-3 text-[15px] font-medium text-white">
            Built in <span className="ml-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11.5px] text-zinc-400">{mine.builtIn.length}</span>
          </p>
          <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06] bg-panel">
            {mine.builtIn
              .filter((b) => m(b.title))
              .map((b) => (
                <div key={b.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="font-mono text-[12px] text-zinc-500">/{b.id}</span>
                  <span className="text-[13.5px] text-zinc-200">{b.title}</span>
                </div>
              ))}
          </div>
        </div>
        <div>
          <p className="mb-3 text-[15px] font-medium text-white">
            From skills-hub.ai <span className="ml-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11.5px] text-zinc-400">{mine.installed.length}</span>
          </p>
          {mine.installed.length === 0 ? (
            <p className="text-sm text-zinc-500">None yet. Use Discover to add one, or the Assistant installs them when a task needs one (you approve).</p>
          ) : (
            <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06] bg-panel">
              {mine.installed
                .filter((h) => m(`${h.name} ${h.description}`))
                .map((h) => (
                  <div key={h.slug} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] text-zinc-100">{h.name}</p>
                      <p className="truncate text-[12px] text-zinc-500">
                        {h.author || "unknown"}
                        {h.aiVerdict ? ` · security review ${h.aiVerdict}` : ""} · {h.description}
                      </p>
                    </div>
                    <button onClick={() => void act(h.slug, { remove: h.slug })} className="text-[12px] text-zinc-500 hover:text-[var(--critical-text)]">
                      {busy === h.slug ? "Removing…" : "Remove"}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        {err && <p className="text-[12.5px] text-[var(--critical-text)]">{err}</p>}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-br from-[var(--hero-a)] to-[var(--hero-b)] p-6">
        <p className="text-[12px] text-emerald-300/70">From skills-hub.ai</p>
        <p className="mt-1 text-[22px] font-semibold tracking-tight text-white">Teach the Assistant new tricks</p>
        <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-zinc-400">Playbooks for frameworks, platforms and audits, written by the community. Added skills are guidance only: they can&apos;t change approvals or reveal secrets.</p>
      </div>
      <p className="mb-3 text-[15px] font-medium text-white">{q ? `Results for “${q}”` : "For you"}</p>
      {err && <p className="mb-3 text-[12.5px] text-[var(--critical-text)]">{err}</p>}
      {!hub ? (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" /> Searching skills-hub.ai…
        </p>
      ) : hub.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing found.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {hub.map((h) => (
            <div key={h.slug} className="flex gap-3.5 rounded-xl border border-white/[0.06] bg-panel p-4 transition-colors hover:border-white/[0.12]">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-panel-2 font-mono text-[13px] text-zinc-400">{"{ }"}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14.5px] font-medium text-white">{h.name}</p>
                <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-zinc-400">{h.description}</p>
                <p className="mt-1.5 truncate text-[11.5px] text-zinc-600">
                  by {h.author || "unknown"}
                  {h.trusted ? " ✓" : ""} · {h.installs.toLocaleString()} installs{h.aiVerdict ? ` · review ${h.aiVerdict}` : ""}
                </p>
              </div>
              {installed.has(h.slug) ? (
                <Check className="mt-1 size-4 shrink-0 text-[var(--good)]" />
              ) : (
                <button
                  onClick={() => void act(h.slug, { install: h.slug })}
                  disabled={busy === h.slug || h.aiVerdict === "FAIL"}
                  title={h.aiVerdict === "FAIL" ? "Failed skills-hub's security review" : `Add ${h.name}`}
                  className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/10 text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
                >
                  {busy === h.slug ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
