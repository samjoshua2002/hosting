"use client";

import {
  Activity,
  Archive,
  BarChart3,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  Code2,
  Container,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Leaf,
  LineChart,
  Loader2,
  Lock,
  Plus,
  SendHorizonal,
  Table2,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/chat-blocks";
import { useCluster } from "@/components/cluster";
import { DatabasesSection } from "@/components/databases-section";
import { Markdown } from "@/components/markdown";
import { PageHero } from "@/components/page-hero";
import { Button, Card, cx } from "@/components/ui";
import { CATALOG, CATEGORIES, serviceIdOf, template, USAGE, type ServiceCategory, type ServiceTemplate } from "@/lib/catalog";
import { api } from "@/lib/client";
import type { JobLog, ProjectState } from "@/lib/types";

const ICON: Record<string, LucideIcon> = {
  postgres: Database,
  mysql: Database,
  mariadb: Database,
  mongodb: Leaf,
  redis: Zap,
  pgadmin: Table2,
  phpmyadmin: Table2,
  adminer: Table2,
  "mongo-express": Table2,
  redisinsight: Table2,
  cloudbeaver: Table2,
  minio: Archive,
  "uptime-kuma": Activity,
  grafana: LineChart,
  n8n: Workflow,
  metabase: BarChart3,
  ollama: Bot,
  "code-server": Code2,
  portainer: Container,
};
const ENGINE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL", mongo: "MongoDB", redis: "Redis" };

interface Installed {
  name: string;
  id: string;
  t: ServiceTemplate;
  inst: { vm: string; p: ProjectState }[];
}

interface Install {
  name: string;
  vm: string;
  jobId: string;
  stage: string;
  pct: number;
  state: "running" | "done" | "failed";
  notes: string[];
}

/** Turn a deploy log into a friendly step. */
function stageOf(log: string): { stage: string; pct: number } {
  if (/==> done/.test(log)) return { stage: "Ready", pct: 100 };
  if (/publishing port/.test(log)) return { stage: "Creating its link…", pct: 90 };
  if (/\(re\)starting service/.test(log)) return { stage: "Starting…", pct: 78 };
  if (/pulling manifest|pulling [0-9a-f]{12}/.test(log)) return { stage: "Downloading the AI model (a few minutes)…", pct: 62 };
  if (/Pull complete|Downloaded newer image|Image is up to date|Status: /.test(log)) return { stage: "Downloaded, setting up…", pct: 55 };
  if (/Pulling fs layer|Downloading|docker pull/.test(log)) return { stage: "Downloading…", pct: 30 };
  return { stage: "Preparing…", pct: 12 };
}

export default function ServicesPage() {
  const { vms, status, refresh, openJob } = useCluster();
  const [cat, setCat] = useState<ServiceCategory | "All">("All");
  const [installs, setInstalls] = useState<Record<string, Install>>({});
  const [fresh, setFresh] = useState<string | null>(null);

  // every recognised service, one entry per name (a service can run on several machines)
  const installed = useMemo(() => {
    const map = new Map<string, Installed>();
    for (const v of vms)
      for (const p of status[v.name]?.agent?.projects ?? []) {
        const id = serviceIdOf(p.manifest);
        const t = id ? template(id) : undefined;
        if (!id || !t) continue;
        const e = map.get(p.manifest.name) ?? { name: p.manifest.name, id, t, inst: [] };
        e.inst.push({ vm: v.name, p });
        map.set(p.manifest.name, e);
      }
    return [...map.values()];
  }, [vms, status]);
  const byTemplate = (id: string) => installed.filter((x) => x.id === id);
  const apps = installed.filter((x) => x.t.type !== "database");

  const install = async (t: ServiceTemplate) => {
    setInstalls((s) => ({ ...s, [t.id]: { name: "", vm: "", jobId: "", stage: "Choosing the best machine…", pct: 6, state: "running", notes: [] } }));
    try {
      const r = await api<{ name: string; vm: string; jobId: string; notes: string[] }>("/api/services", { template: t.id });
      const base: Install = { ...r, stage: `Installing on ${r.vm}…`, pct: 10, state: "running" };
      setInstalls((s) => ({ ...s, [t.id]: base }));
      // follow the deploy until it finishes
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2500));
        const j = await api<JobLog>(`/api/jobs/log?vm=${encodeURIComponent(r.vm)}&id=${encodeURIComponent(r.jobId)}`).catch(() => null);
        if (!j) continue;
        const st = stageOf(j.log);
        const state: Install["state"] = j.state === "running" ? "running" : j.state === "done" && j.exitCode === 0 ? "done" : "failed";
        setInstalls((s) => ({ ...s, [t.id]: { ...base, stage: state === "failed" ? "Didn't finish" : st.stage, pct: state === "done" ? 100 : st.pct, state } }));
        if (state !== "running") break;
      }
      await refresh([r.vm]);
      setFresh(r.name);
      setTimeout(() => document.getElementById(`svc-${r.name}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
    } catch (e) {
      setInstalls((s) => ({ ...s, [t.id]: { name: "", vm: "", jobId: "", stage: (e as Error).message, pct: 0, state: "failed", notes: [] } }));
    }
  };

  const shown = CATALOG.filter((t) => cat === "All" || t.category === cat);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 px-10 py-8">
      <PageHero
        eyebrow="Databases, tools, apps"
        title="Services"
        icon={<Boxes className="size-6" />}
        desc="Ready-made software next to your projects. One click installs it on the best machine with strong passwords, and tells you how to use it."
        actions={
          <Button variant="primary" onClick={() => document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth" })}>
            <Plus className="size-4" /> Add a service
          </Button>
        }
      />

      <Section title="Databases" hint="Private on 127.0.0.1. These are the real passwords (random and strong), ready to copy.">
        <DatabasesSection />
      </Section>

      <Section title="Your services" hint="Open them, sign in, and see how to use each one.">
        {apps.length === 0 ? (
          <Card className="p-6 text-sm text-muted">Nothing yet. pgAdmin, phpMyAdmin, Uptime Kuma, n8n, Ollama and more are one click away below.</Card>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {apps.map((x) => (
              <ServiceCard key={x.name} x={x} open={x.name === fresh} />
            ))}
          </div>
        )}
      </Section>

      <section id="catalog" className="scroll-mt-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-[15px] font-semibold text-white">Add a service</h2>
          {(["All", ...CATEGORIES] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={cx("rounded-full border px-3 py-1 text-xs transition-colors", cat === c ? "border-white bg-white font-medium text-[#0b0e1c]" : "border-line-strong text-ink hover:border-white/30")}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {shown.map((t) => {
            const Icon = ICON[t.id] ?? Boxes;
            const have = byTemplate(t.id);
            const job = installs[t.id];
            const link = have.flatMap((h) => h.inst).find((i) => i.p.url)?.p.url;
            return (
              <Card key={t.id} className={cx("flex flex-col p-4 transition-colors", have.length ? "border-accent/30" : "hover:border-white/15")}>
                <div className="flex items-start gap-3">
                  <span className={cx("grid size-10 shrink-0 place-items-center rounded-xl border bg-chip text-ink", have.length ? "border-accent/50" : "border-line-strong")}>
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-white">{t.name}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{t.desc}</p>
                  </div>
                </div>

                {job?.state === "running" ? (
                  <div className="mt-auto pt-4">
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-ink">
                        <Loader2 className="size-3.5 animate-spin text-accent" /> {job.stage}
                      </span>
                      {job.jobId && (
                        <button onClick={() => openJob({ vm: job.vm, id: job.jobId, title: `install ${job.name}` })} className="text-muted hover:text-white">
                          details
                        </button>
                      )}
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-track">
                      <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${job.pct}%` }} />
                    </div>
                  </div>
                ) : (
                  <div className="mt-auto flex items-center gap-1.5 pt-4">
                    {have.length ? (
                      <span className="flex items-center gap-1 text-xs text-ink">
                        <Check className="size-3.5 text-accent-soft" /> Installed on {[...new Set(have.flatMap((h) => h.inst.map((i) => i.vm)))].join(", ")}
                      </span>
                    ) : job?.state === "failed" ? (
                      <span className="truncate text-xs text-[var(--critical-text)]" title={job.stage}>
                        {job.stage}
                        {job.jobId && (
                          <button onClick={() => openJob({ vm: job.vm, id: job.jobId, title: `install ${job.name}` })} className="ml-1 underline">
                            log
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted">
                        {t.connects ? `for ${t.connects.engines.length > 1 ? "SQL databases" : ENGINE_LABEL[t.connects.engines[0]]}` : t.category}
                        {t.ram ? ` · needs ~${t.ram}` : ""}
                      </span>
                    )}
                    <span className="flex-1" />
                    {have.length ? (
                      <>
                        {link && (
                          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-[#0b0e1c] hover:bg-white/90">
                            Open <ExternalLink className="size-3" />
                          </a>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => void install(t)} title="Install a second one">
                          <Plus className="size-3.5" /> Another
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="primary" onClick={() => void install(t)}>
                        <Plus className="size-3.5" /> Add
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-[15px] font-semibold text-white">{title}</h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** One of your services: open it, sign in, how to use it (and try Ollama right here). */
function ServiceCard({ x, open: initiallyOpen }: { x: Installed; open: boolean }) {
  const m = x.inst[0].p.manifest;
  const Icon = ICON[x.id] ?? Boxes;
  const login = x.t.login;
  const url = x.inst.find((i) => i.p.url)?.p.url ?? null;
  const vm = x.inst[0].vm;
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [howOpen, setHowOpen] = useState(initiallyOpen || x.id === "ollama");
  const ok = x.inst.every((i) => i.p.active === "active");
  const failed = x.inst.some((i) => i.p.active === "failed");

  const load = async () => {
    if (env) return env;
    setLoading(true);
    try {
      const r = await api<{ env: { key: string; value: string }[] }>("/api/projects/action", { vm, name: m.name, action: "env" });
      const e = Object.fromEntries(r.env.map((v) => [v.key, v.value]));
      setEnv(e);
      return e;
    } finally {
      setLoading(false);
    }
  };
  const user = login?.user ?? (login?.userEnv ? env?.[login.userEnv] : undefined);
  const pass = login?.passEnv ? env?.[login.passEnv] : undefined;
  const fill = (s: string) =>
    s
      .replaceAll("{vm}", vm)
      .replaceAll("{name}", m.name)
      .replaceAll("{NAME}", m.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"))
      .replaceAll("{port+1}", String((m.port ?? 0) + 1))
      .replaceAll("{port}", String(m.port ?? ""));

  return (
    <Card id={`svc-${m.name}`} className={cx("flex flex-col p-5", initiallyOpen && "ring-2 ring-accent/40")}>
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-line-strong bg-chip text-ink">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={`/projects/${m.name}`} className="block truncate text-base font-semibold text-white hover:underline">
            {m.name}
          </Link>
          <p className="truncate text-xs text-muted">
            {x.t.name} · {x.inst.map((i) => i.vm).join(", ")}
            {m.uses?.length ? ` · connected to ${m.uses.map((u) => u.name).join(", ")}` : ""}
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-ink">
          <span className={cx("size-2 rounded-full", ok ? "bg-[var(--good)]" : failed ? "bg-[var(--critical)]" : "bg-[var(--others)]")} />
          {ok ? "Running" : failed ? "Crashed" : x.inst[0].p.active}
        </span>
      </div>

      {url && (
        <div className="mt-4 flex items-center gap-2">
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-[#0b0e1c] hover:bg-white/90">
            Open {x.t.name.split(" (")[0]} <ExternalLink className="size-3.5" />
          </a>
          {url.includes("_token=") && (
            <span className="flex items-center gap-1 text-[11px] text-muted">
              <Lock className="size-3" /> private link
            </span>
          )}
          <span className="flex-1" />
          <CopyButton text={url} label="Copy link" />
        </div>
      )}

      {login && (login.user || login.userEnv || login.passEnv) && (
        <div className="mt-4 grid grid-cols-[80px_minmax(0,1fr)] items-center gap-y-1.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5 text-xs">
          {(login.user || login.userEnv) && (
            <>
              <span className="text-muted">Sign in as</span>
              <span className="flex items-center gap-1 font-mono text-ink">
                {user ?? (
                  <button onClick={() => void load()} className="text-muted hover:text-white">
                    show
                  </button>
                )}
                {user && <CopyButton text={user} />}
              </span>
            </>
          )}
          {login.passEnv && (
            <>
              <span className="text-muted">Password</span>
              <span className="flex min-w-0 items-center gap-1 font-mono text-ink">
                <span className="truncate">{show && pass !== undefined ? pass || "(none)" : "••••••••••••••"}</span>
                <button
                  onClick={async () => {
                    await load();
                    setShow((s) => !s);
                  }}
                  className="p-0.5 text-muted hover:text-white"
                  aria-label={show ? "Hide password" : "Show password"}
                >
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
                {pass !== undefined && <CopyButton text={pass} />}
              </span>
            </>
          )}
        </div>
      )}

      <button onClick={() => setHowOpen((o) => !o)} className="mt-4 flex items-center gap-1.5 text-sm font-medium text-white">
        <ChevronDown className={cx("size-4 transition-transform", !howOpen && "-rotate-90")} /> How to use it
      </button>
      {howOpen && (
        <div className="mt-2 space-y-3">
          <ol className="space-y-1.5 text-sm text-ink">
            {(USAGE[x.id] ?? []).map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-chip text-[11px] text-muted">{i + 1}</span>
                <span>{fill(line)}</span>
              </li>
            ))}
            {login?.note && (
              <li className="flex gap-2 text-muted">
                <span className="size-5 shrink-0" />
                <span>{login.note}</span>
              </li>
            )}
          </ol>
          {x.id === "ollama" && <OllamaTry name={m.name} url={url} />}
        </div>
      )}
    </Card>
  );
}

/** Chat with an Ollama service right here, plus code to call it. */
function OllamaTry({ name, url }: { name: string; url: string | null }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<{ model: string; answer: string; ms: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"curl" | "python" | "js">("curl");

  const ask = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setA(await api<{ model: string; answer: string; ms: number }>("/api/services/try", { name, prompt: q }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  let api_ = "http://127.0.0.1:11434/api/generate";
  if (url)
    try {
      const u = new URL(url);
      api_ = `${u.origin}/api/generate${u.search}`;
    } catch {}
  const model = a?.model ?? "llama3.2:3b";
  const code = {
    curl: `curl "${api_}" \\\n  -d '{"model": "${model}", "prompt": "Why is the sky blue?", "stream": false}'`,
    python: `import requests\n\nr = requests.post("${api_}", json={\n    "model": "${model}",\n    "prompt": "Why is the sky blue?",\n    "stream": False,\n})\nprint(r.json()["response"])`,
    js: `const r = await fetch("${api_}", {\n  method: "POST",\n  body: JSON.stringify({ model: "${model}", prompt: "Why is the sky blue?", stream: false }),\n});\nconsole.log((await r.json()).response);`,
  }[tab];

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/[0.08] bg-black/25 p-3">
        <p className="mb-2 text-xs font-medium text-muted">Try it</p>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void ask()}
            placeholder="Ask the model anything…"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 text-sm text-white outline-none placeholder:text-muted focus:border-accent/60"
          />
          <Button size="sm" variant="primary" onClick={() => void ask()} loading={busy} disabled={!q.trim()}>
            <SendHorizonal className="size-3.5" />
          </Button>
        </div>
        {busy && <p className="mt-2 text-xs text-muted">Thinking… the first answer takes longer while the model loads.</p>}
        {err && <p className="mt-2 text-xs text-[var(--critical-text)]">{err}</p>}
        {a && !busy && (
          <div className="mt-3 text-sm">
            <Markdown text={a.answer} />
            <p className="mt-1 text-[11px] text-muted">
              {a.model} · {(a.ms / 1000).toFixed(1)} s
            </p>
          </div>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#07080d]">
        <div className="flex items-center gap-1 border-b border-white/[0.06] px-2 py-1">
          {(["curl", "python", "js"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx("rounded-md px-2 py-0.5 text-[11px]", tab === t ? "bg-white/[0.1] text-white" : "text-muted hover:text-white")}>
              {t === "js" ? "JavaScript" : t === "python" ? "Python" : "curl"}
            </button>
          ))}
          <span className="flex-1" />
          <CopyButton text={code} label="Copy" />
        </div>
        <pre className="scroll-thin overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink">{code}</pre>
      </div>
    </div>
  );
}
