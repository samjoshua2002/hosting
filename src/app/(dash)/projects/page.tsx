"use client";

import { Bell, ChevronsUpDown, Container, Cpu, Database, EllipsisVertical, ExternalLink, Folder, FolderGit2, GitBranch, Globe, Lock, Plus, Search, Server, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCluster } from "@/components/cluster";
import { Drawer } from "@/components/drawer";
import { GithubConnect, GithubMark, RepoPicker, useGithub, type Repo } from "@/components/github";
import { PageHero } from "@/components/page-hero";
import { PRESETS, ProjectForm, blank, formFromManifest, urlFor, type FormState } from "@/components/project-form";
import { Button, Card, cx } from "@/components/ui";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import { rankMachines } from "@/lib/placement";
import { projectType, TYPE_LABEL, TYPE_ORDER, type ProjectType } from "@/lib/project-type";
import type { CommitInfo, JobStartResult, JobState, ProjectManifest, ProjectState, VmStatus } from "@/lib/types";

interface Instance {
  vm: string;
  state: ProjectState;
  url: string | null;
  deploying: boolean;
}

interface Project {
  name: string;
  m: ProjectManifest;
  type: ProjectType;
  instances: Instance[];
}

const ICON: Record<ProjectType, LucideIcon> = { website: Globe, service: Server, worker: Cpu, database: Database, tool: Wrench };

type Tone = "ok" | "busy" | "bad" | "off";
const TONE_DOT: Record<Tone, string> = {
  ok: "bg-[var(--good)]",
  busy: "bg-accent animate-pulse-dot",
  bad: "bg-[var(--critical)]",
  off: "bg-[var(--others)]",
};

function health(p: Project): { label: string; tone: Tone } {
  const s = p.instances.map((i) => i.state.active);
  if (p.instances.some((i) => i.deploying)) return { label: "Building", tone: "busy" };
  if (s.includes("failed")) return { label: "Error", tone: "bad" };
  if (s.some((x) => x === "activating" || x === "reloading")) return { label: "Starting", tone: "busy" };
  if (!p.m.start) return { label: "Built", tone: "ok" };
  if (s.every((x) => x === "active")) return { label: "Ready", tone: "ok" };
  if (s.some((x) => x === "active")) return { label: `${s.filter((x) => x === "active").length}/${s.length} running`, tone: "busy" };
  return { label: "Stopped", tone: "off" };
}

/** Where it lives, in one short line. */
function address(p: Project): { text: string; href?: string; locked?: boolean } {
  const url = p.instances.find((i) => i.url)?.url;
  if (url) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {}
    return { text: host, href: url, locked: url.includes("_token=") };
  }
  if (p.type === "database") return { text: p.m.port ? `127.0.0.1:${p.m.port} · private` : "private", locked: true };
  if (!p.m.port) return { text: "no port · runs in the background" };
  return { text: `port ${p.m.port} · no public link` };
}

function source(m: ProjectManifest): { icon: "github" | "git" | "docker" | "files"; text: string; docker?: boolean } {
  if (m.github) return { icon: "github", text: m.github.repo };
  if (m.repo) return { icon: "git", text: m.repo.replace(/^https:\/\/([^@/]*@)?/, "").replace(/\.git$/, "") };
  const image = `${m.start} ${m.build}`.match(/docker (?:run|pull)\b.*?\s([a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+)/)?.[1];
  if (image || /docker/.test(m.start)) return { icon: "docker", text: image ?? "Docker", docker: true };
  return { icon: "files", text: `~/apps/${m.name}` };
}

/** The middle line: the deployed commit, or what runs when there's no git. */
function summary(p: Project, commit: CommitInfo | null | undefined, src: ReturnType<typeof source>): { text: string; mono?: boolean } {
  if (commit) return { text: commit.message };
  if (p.m.repo) return { text: "Not deployed from git yet" };
  const env = p.m.envKeys.length ? ` · ${p.m.envKeys.length} env var${p.m.envKeys.length > 1 ? "s" : ""}` : "";
  if (src.docker) return { text: `Docker container${p.m.port ? ` on port ${p.m.port}` : ""}${env}` };
  if (!p.m.start) return { text: "Build only" };
  return { text: p.m.start, mono: true };
}

export default function ProjectsPage() {
  const { vms, status, checking, openJob, refresh } = useCluster();
  const gh = useGithub();
  const [form, setForm] = useState<{ state: FormState; importRepo?: Repo } | null>(null);
  const [connect, setConnect] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ProjectType | "all">("all");
  const [error, setError] = useState<string | null>(null);

  const projects = useMemo(() => {
    const map = new Map<string, Project>();
    for (const v of vms) {
      const a = status[v.name]?.agent;
      for (const p of a?.projects ?? []) {
        const name = p.manifest.name;
        const deploying = (a?.jobs ?? []).some((j) => j.state === "running" && j.meta.kind === "deploy" && j.meta.project === name);
        const entry = map.get(name) ?? { name, m: p.manifest, type: projectType(p.manifest), instances: [] };
        entry.instances.push({ vm: v.name, state: p, url: urlFor(p.manifest, a?.ports ?? [], p.url), deploying });
        map.set(name, entry);
      }
    }
    return [...map.values()].sort((a, b) => latest(b) - latest(a) || a.name.localeCompare(b.name));
  }, [vms, status]);

  const counts = useMemo(() => {
    const c: Partial<Record<ProjectType, number>> = {};
    for (const p of projects) c[p.type] = (c[p.type] ?? 0) + 1;
    return c;
  }, [projects]);

  const shown = projects.filter((p) => {
    if (filter !== "all" && p.type !== filter) return false;
    const t = q.trim().toLowerCase();
    return !t || p.name.includes(t) || (p.m.github?.repo ?? p.m.repo).toLowerCase().includes(t) || (p.m.framework ?? "").toLowerCase().includes(t);
  });

  // new projects start on the best machine for their type; the form can change it
  const newProject = (extra?: Partial<FormState>, importRepo?: Repo) => {
    const best = rankMachines(vms.map((v) => v.name), status, extra?.type ?? "website", "box5");
    setForm({ state: { ...blank(best.slice(0, 1)), ...extra }, importRepo });
  };

  // the top bar's Deploy button and ⌘K open the form with ?new=1
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("new")) return;
    window.history.replaceState(null, "", "/projects");
    queueMicrotask(() => newProject());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actAll = async (p: Project, action: "deploy" | "restart" | "stop" | "start" | "remove") => {
    if (action === "remove" && !confirm(`Remove ${p.name} from ${p.instances.map((i) => i.vm).join(", ")}? This stops it and deletes its files there.`)) return;
    setError(null);
    const results = await Promise.allSettled(p.instances.map((i) => api<{ jobId?: string }>("/api/projects/action", { vm: i.vm, name: p.name, action })));
    const failed = results.flatMap((r, k) => (r.status === "rejected" ? [`${p.instances[k].vm}: ${(r.reason as Error).message}`] : []));
    if (failed.length) setError(`${p.name}: ${failed.join("; ")}`);
    const first = results.find((r): r is PromiseFulfilledResult<{ jobId?: string }> => r.status === "fulfilled" && Boolean(r.value.jobId));
    if (action === "deploy" && first) openJob({ vm: p.instances[results.indexOf(first)].vm, id: first.value.jobId!, title: `deploy ${p.name}` });
    void refresh(p.instances.map((i) => i.vm));
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
      <PageHero
        eyebrow="Websites, services, databases"
        title="Projects"
        icon={<FolderGit2 className="size-6" />}
        desc="Import a GitHub repo or start from a template. Every project runs as a restarting service on the machines you pick, and GitHub projects redeploy on each push."
        actions={
          <>
            <Button onClick={() => setConnect(true)}>
              <GithubMark />
              {gh.status?.connected ? `@${gh.status.login}` : "Connect GitHub"}
            </Button>
            <Button variant="primary" onClick={() => newProject()}>
              <Plus className="size-4" /> New project
            </Button>
          </>
        }
      />

      {error && <pre className="rounded-lg border border-[var(--critical)]/40 p-3 text-sm whitespace-pre-wrap text-[var(--critical-text)]">{error}</pre>}

      <div className="grid grid-cols-[minmax(0,340px)_minmax(0,1fr)] items-start gap-8">
        <aside className="space-y-8">
          <Usage vms={vms.map((v) => v.name)} status={status} />
          <Alerts vms={vms.map((v) => v.name)} status={status} />
          <RecentDeploys vms={vms.map((v) => v.name)} status={status} onOpen={openJob} />
        </aside>

        <section className="min-w-0">
          <div className="mb-3 flex h-9 items-center gap-2">
            <h2 className="text-[15px] font-semibold text-white">Projects</h2>
            {projects.length > 0 && <span className="text-sm text-muted">{projects.length}</span>}
            <span className="flex-1" />
            {projects.length > 0 && (
              <>
                <SearchToggle value={q} onChange={setQ} />
                <TypeFilter value={filter} onChange={setFilter} counts={counts} total={projects.length} />
              </>
            )}
          </div>

          {projects.length === 0 && vms.some((v) => checking[v.name] || !status[v.name]) ? (
            <div className="grid grid-cols-2 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <Card key={i} className="h-[184px] animate-pulse p-5">
                  <div className="flex gap-3">
                    <span className="size-10 rounded-xl bg-chip" />
                    <span className="mt-1 h-4 w-32 rounded bg-chip" />
                  </div>
                </Card>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <Welcome connected={gh.status?.connected} onImport={(r) => newProject({}, r)} onConnect={() => setConnect(true)} onTemplate={(v) => newProject(v)} />
          ) : shown.length ? (
            <Grid list={shown} status={status} onAct={actAll} onEdit={(p) => setForm({ state: formFromManifest(p.m, p.instances.map((i) => i.vm)) })} />
          ) : (
            <p className="py-16 text-center text-sm text-muted">No projects match.</p>
          )}
        </section>
      </div>

      {form && (
        <ProjectForm
          initial={form.state}
          importRepo={form.importRepo}
          onClose={() => setForm(null)}
          onDeployed={(jobs: JobStartResult[], warning?: string) => {
            const name = form.state.name;
            setForm(null);
            const first = jobs.find((j) => j.id);
            if (first?.id) openJob({ vm: first.vm, id: first.id, title: `deploy ${name || "project"}` });
            const failed = jobs.filter((j) => j.error).map((j) => `${j.vm}: ${j.error}`);
            setError([...failed, warning].filter(Boolean).join("\n") || null);
            void refresh(jobs.map((j) => j.vm));
          }}
        />
      )}
      {connect && (
        <Drawer title="GitHub" subtitle="Import repos and redeploy on every push." onClose={() => setConnect(false)}>
          <GithubConnect />
        </Drawer>
      )}
    </div>
  );
}

function latest(p: Project): number {
  return Math.max(0, ...p.instances.map((i) => i.state.commit?.time ?? i.state.deployedAt ?? 0));
}

function Grid({ list, status, onAct, onEdit }: { list: Project[]; status: Record<string, VmStatus | undefined>; onAct: (p: Project, a: "deploy" | "restart" | "stop" | "start" | "remove") => Promise<void>; onEdit: (p: Project) => void }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {list.map((p) => (
        <ProjectCard key={p.name} p={p} online={p.instances.every((i) => status[i.vm]?.ok)} onAct={(a) => onAct(p, a)} onEdit={() => onEdit(p)} />
      ))}
    </div>
  );
}

function ProjectCard({ p, online, onAct, onEdit }: { p: Project; online: boolean; onAct: (a: "deploy" | "restart" | "stop" | "start" | "remove") => Promise<void>; onEdit: () => void }) {
  const Icon = ICON[p.type];
  const h = health(p);
  const addr = address(p);
  const src = source(p.m);
  const commit = p.instances.find((i) => i.state.commit)?.state.commit;
  const deployedAt = Math.max(0, ...p.instances.map((i) => i.state.deployedAt ?? 0));
  const line = summary(p, commit, src);

  return (
    <Card className="group relative flex min-w-0 flex-col p-5 transition-colors hover:border-white/15 hover:bg-panel">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line-strong bg-chip text-ink">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={`/projects/${p.name}`} className="block truncate font-semibold text-white after:absolute after:inset-0 after:rounded-2xl">
            {p.name}
          </Link>
          {addr.href ? (
            <a href={addr.href} target="_blank" rel="noreferrer" className="relative z-10 flex items-center gap-1 truncate text-sm text-muted hover:text-white hover:underline">
              {addr.locked && <Lock className="size-3 shrink-0" />}
              <span className="truncate">{addr.text}</span>
            </a>
          ) : (
            <p className="flex items-center gap-1 truncate text-sm text-muted">
              {addr.locked && <Lock className="size-3 shrink-0" />}
              <span className="truncate">{addr.text}</span>
            </p>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs text-ink" title={p.instances.map((i) => `${i.vm}: ${i.state.active}`).join("\n")}>
          <span className={cx("size-2 rounded-full", TONE_DOT[h.tone])} />
          {h.label}
        </span>
        <Menu p={p} addr={addr.href} onAct={onAct} onEdit={onEdit} />
      </div>

      <div className="mt-4 flex min-w-0 items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line-strong bg-white/[0.03] px-2.5 py-1 text-xs text-ink">
          {src.icon === "github" ? <GithubMark className="size-3.5" /> : src.icon === "git" ? <GitBranch className="size-3.5" /> : src.icon === "docker" ? <Container className="size-3.5" /> : <Folder className="size-3.5" />}
          <span className="truncate">{src.text}</span>
        </span>
        {p.m.framework && <span className="shrink-0 text-xs text-muted">{p.m.framework}</span>}
      </div>

      <p className={cx("mt-3 truncate text-ink", line.mono ? "font-mono text-xs leading-5" : "text-sm")} title={commit ? `${commit.sha.slice(0, 7)} by ${commit.author}` : line.text}>
        {line.text}
      </p>

      <div className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted">
        <span>{timeAgo(commit?.time ? commit.time * 1000 : deployedAt ? deployedAt * 1000 : null)}</span>
        {p.m.repo && (
          <>
            <span>on</span>
            <GitBranch className="size-3" />
            <span className="font-mono">{p.m.branch}</span>
          </>
        )}
        {p.m.github?.autoDeploy && <span title="Redeploys on every push">· auto</span>}
        <span className="flex-1" />
        {!online && <span className="text-[var(--critical-text)]">machine asleep</span>}
        {p.instances.map((i) => (
          <span key={i.vm} className="rounded bg-chip px-1.5 py-px font-mono text-[11px] text-ink">
            {i.vm}
          </span>
        ))}
      </div>
    </Card>
  );
}

function Menu({ p, addr, onAct, onEdit }: { p: Project; addr?: string; onAct: (a: "deploy" | "restart" | "stop" | "start" | "remove") => Promise<void>; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const running = p.instances.some((i) => i.state.active === "active");
  const item = (label: string, run: () => void, danger = false) => (
    <button
      onClick={() => {
        setOpen(false);
        run();
      }}
      className={cx("block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-white/[0.06]", danger ? "text-[var(--critical-text)]" : "text-ink")}
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative z-10 -mt-1 -mr-2">
      <button onClick={() => setOpen((o) => !o)} className="grid size-7 place-items-center rounded-md text-muted hover:bg-white/[0.06] hover:text-white" aria-label="Project actions">
        <EllipsisVertical className="size-4" />
      </button>
      {open && (
        <div className="absolute top-8 right-0 w-48 rounded-xl border border-line-strong bg-panel p-1 shadow-2xl shadow-black/50">
          {addr && (
            <a href={addr} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-ink hover:bg-white/[0.06]">
              Visit <ExternalLink className="size-3.5 text-muted" />
            </a>
          )}
          {item(p.m.repo ? "Redeploy latest" : "Redeploy", () => void onAct("deploy"))}
          {item("Restart", () => void onAct("restart"))}
          {running ? item("Stop", () => void onAct("stop")) : item("Start", () => void onAct("start"))}
          {item("Settings", onEdit)}
          <div className="my-1 border-t border-line-strong" />
          {item("Remove", () => void onAct("remove"), true)}
        </div>
      )}
    </div>
  );
}

function Welcome({ connected, onImport, onConnect, onTemplate }: { connected?: boolean; onImport: (r: Repo) => void; onConnect: () => void; onTemplate: (v: Partial<FormState>) => void }) {
  return (
    <div className="grid gap-4">
      <Card className="p-6">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-white">
          <GithubMark className="size-5" /> Import Git repository
        </h2>
        <p className="mb-4 text-sm text-muted">Pick a repo; the framework is detected and pushes redeploy it.</p>
        {connected ? (
          <RepoPicker onPick={onImport} limit={5} />
        ) : (
          <Button onClick={onConnect}>
            <GithubMark /> Connect GitHub
          </Button>
        )}
      </Card>
      <Card className="p-6">
        <h2 className="mb-1 text-lg font-semibold text-white">Start from a template</h2>
        <p className="mb-4 text-sm text-muted">Databases, models and containers with no repo needed.</p>
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.slice(0, 9).map((t) => (
            <button key={t.label} onClick={() => onTemplate(t.values)} className="rounded-xl border border-line-strong px-3 py-2 text-left hover:border-accent/60 hover:bg-white/[0.03]">
              <span className="block text-sm font-medium text-white">{t.label}</span>
              <span className="block text-[11px] text-muted">{t.hint}</span>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function SearchToggle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const shown = open || Boolean(value);
  return shown ? (
    <label className="flex h-9 w-64 items-center gap-2 rounded-lg border border-line-strong bg-panel/80 px-2.5 focus-within:border-accent/60">
      <Search className="size-4 shrink-0 text-muted" />
      <input
        ref={ref}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => !value && setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            setOpen(false);
          }
        }}
        placeholder="Find a project"
        className="w-full bg-transparent text-sm text-white outline-none placeholder:text-muted"
      />
      {value && (
        <button onClick={() => onChange("")} className="text-muted hover:text-white" aria-label="Clear">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  ) : (
    <button onClick={() => setOpen(true)} className="grid size-9 place-items-center rounded-lg border border-line-strong text-muted hover:border-white/20 hover:text-white" aria-label="Search projects" title="Search">
      <Search className="size-4" />
    </button>
  );
}

function TypeFilter({ value, onChange, counts, total }: { value: ProjectType | "all"; onChange: (v: ProjectType | "all") => void; counts: Partial<Record<ProjectType, number>>; total: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const opts: (ProjectType | "all")[] = ["all", ...TYPE_ORDER.filter((t) => counts[t])];
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm text-ink hover:border-white/20">
        {value === "all" ? "All types" : TYPE_LABEL[value].many}
        <ChevronsUpDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div className="absolute top-10 right-0 z-20 w-52 rounded-xl border border-line-strong bg-panel p-1 shadow-2xl shadow-black/50">
          {opts.map((t) => {
            const Icon = t === "all" ? FolderGit2 : ICON[t];
            return (
              <button
                key={t}
                onClick={() => {
                  onChange(t);
                  setOpen(false);
                }}
                className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-white/[0.06]", value === t ? "text-white" : "text-ink")}
              >
                <Icon className="size-3.5 text-muted" />
                <span className="flex-1">{t === "all" ? "All types" : TYPE_LABEL[t].many}</span>
                <span className="text-xs text-muted">{t === "all" ? total : counts[t]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** warn: "high" when a full ring is bad (CPU, disk), "low" when an empty one is (machines online). */
function Ring({ value, warn }: { value: number; warn: "high" | "low" }) {
  const v = Math.max(0, Math.min(100, value));
  const c = 2 * Math.PI * 7;
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] shrink-0 -rotate-90">
      <circle cx="9" cy="9" r="7" fill="none" stroke="var(--track)" strokeWidth="2.2" />
      <circle cx="9" cy="9" r="7" fill="none" stroke={(warn === "high" ? v >= 90 : v < 100) ? "var(--critical)" : "var(--accent)"} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />
    </svg>
  );
}

function SideTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex h-9 items-center justify-between">
      <h2 className="text-[15px] font-semibold text-white">{children}</h2>
      {right}
    </div>
  );
}

type StatusMap = Record<string, VmStatus | undefined>;

function Usage({ vms, status }: { vms: string[]; status: StatusMap }) {
  const live = vms.map((v) => status[v]?.agent).filter((a): a is NonNullable<VmStatus["agent"]> => Boolean(a));
  const online = vms.filter((v) => status[v]?.ok).length;
  const sum = (f: (a: (typeof live)[number]) => number) => live.reduce((n, a) => n + f(a), 0);
  const cpu = live.length ? sum((a) => a.cpuPct) / live.length : 0;
  const memT = sum((a) => a.memTotalKb);
  const memU = memT - sum((a) => a.memAvailKb);
  const diskT = sum((a) => a.diskTotalKb);
  const diskU = sum((a) => a.diskUsedKb);
  const inst = live.flatMap((a) => a.projects);
  const running = inst.filter((p) => p.active === "active").length;
  const gb = (kb: number) => `${(kb / 1048576).toFixed(kb > 10 * 1048576 ? 0 : 1)} GB`;
  const rows: [string, number, string, "high" | "low"][] = [
    ["Machines online", vms.length ? (online / vms.length) * 100 : 0, `${online} / ${vms.length}`, "low"],
    ["CPU", cpu, `${Math.round(cpu)}% avg · ${sum((a) => a.cores)} cores`, "high"],
    ["Memory", memT ? (memU / memT) * 100 : 0, `${gb(memU)} / ${gb(memT)}`, "high"],
    ["Disk", diskT ? (diskU / diskT) * 100 : 0, `${gb(diskU)} / ${gb(diskT)}`, "high"],
    ["Services running", inst.length ? (running / inst.length) * 100 : 100, `${running} / ${inst.length}`, "low"],
  ];
  return (
    <section>
      <SideTitle>Usage</SideTitle>
      <Card className="p-2">
        <p className="px-3 pt-2 pb-1 text-sm text-ink">Right now</p>
        {rows.map(([label, v, text, warn]) => (
          <div key={label} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-white/[0.03]">
            <Ring value={live.length ? v : 0} warn={live.length ? warn : "high"} />
            <span className="flex-1 text-ink">{label}</span>
            <span className="font-mono text-xs text-muted">{live.length ? text : "…"}</span>
          </div>
        ))}
      </Card>
    </section>
  );
}

function Alerts({ vms, status }: { vms: string[]; status: StatusMap }) {
  const list: { key: string; text: string; href?: string }[] = [];
  for (const v of vms) {
    const s = status[v];
    if (s && !s.ok) list.push({ key: `${v}-down`, text: `${v} is unreachable (paused or cooling down)` });
    const a = s?.agent;
    if (!a) continue;
    for (const p of a.projects) if (p.active === "failed") list.push({ key: `${v}-${p.manifest.name}`, text: `${p.manifest.name} crashed on ${v}`, href: `/projects/${p.manifest.name}` });
    if (a.diskTotalKb && a.diskUsedKb / a.diskTotalKb > 0.85) list.push({ key: `${v}-disk`, text: `${v} disk is ${Math.round((a.diskUsedKb / a.diskTotalKb) * 100)}% full` });
    if (a.memTotalKb && 1 - a.memAvailKb / a.memTotalKb > 0.9) list.push({ key: `${v}-mem`, text: `${v} memory is almost full` });
    // a deploy whose latest run failed
    const latest = new Map<string, JobState>();
    for (const j of [...a.jobs].sort((x, y) => x.meta.startedAt - y.meta.startedAt)) if (j.meta.kind === "deploy" && j.meta.project) latest.set(j.meta.project, j);
    for (const [name, j] of latest) if (j.state === "done" && j.exitCode !== 0) list.push({ key: `${v}-${name}-deploy`, text: `Last deploy of ${name} on ${v} failed`, href: `/projects/${name}` });
  }
  return (
    <section>
      <SideTitle>Alerts</SideTitle>
      <Card className="p-2">
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-7 text-center">
            <span className="grid size-10 place-items-center rounded-xl border border-line-strong text-muted">
              <Bell className="size-4" />
            </span>
            <p className="text-sm text-muted">Nothing needs attention. Crashes, failed deploys and full disks show up here and by email.</p>
          </div>
        ) : (
          list.slice(0, 8).map((x) =>
            x.href ? (
              <Link key={x.key} href={x.href} className="flex items-start gap-2.5 rounded-lg px-3 py-2 text-sm text-ink hover:bg-white/[0.04]">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--critical-text)]" /> {x.text}
              </Link>
            ) : (
              <p key={x.key} className="flex items-start gap-2.5 px-3 py-2 text-sm text-ink">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--critical-text)]" /> {x.text}
              </p>
            ),
          )
        )}
      </Card>
    </section>
  );
}

function RecentDeploys({ vms, status, onOpen }: { vms: string[]; status: StatusMap; onOpen: (j: { vm: string; id: string; title: string }) => void }) {
  const jobs = vms
    .flatMap((v) => (status[v]?.agent?.jobs ?? []).filter((j) => j.meta.kind === "deploy").map((j) => ({ vm: v, j })))
    .sort((a, b) => b.j.meta.startedAt - a.j.meta.startedAt)
    .slice(0, 6);
  return (
    <section>
      <SideTitle>Recent deploys</SideTitle>
      <Card className="divide-y divide-line overflow-hidden">
        {jobs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">Deploys show up here as they run.</p>
        ) : (
          jobs.map(({ vm, j }) => {
            const tone: Tone = j.state === "running" ? "busy" : j.state === "done" && j.exitCode === 0 ? "ok" : "bad";
            const trigger = j.meta.label.includes(" · ") ? j.meta.label.split(" · ").slice(1).join(" · ") : "manual deploy";
            return (
              <button key={`${vm}-${j.id}`} onClick={() => onOpen({ vm, id: j.id, title: j.meta.label })} className="block w-full px-4 py-3 text-left hover:bg-white/[0.03]">
                <div className="flex items-center gap-2">
                  <span className={cx("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
                  <span className="truncate text-sm font-medium text-white">{j.meta.project}</span>
                  <span className="truncate text-xs text-muted">{trigger}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-4 text-xs text-muted">
                  <span className="rounded bg-chip px-1.5 py-px font-mono text-[11px] text-ink">{vm}</span>
                  <span>{j.state === "running" ? "building…" : j.exitCode === 0 ? "ready" : "failed"}</span>
                  <span>·</span>
                  <span>{timeAgo(j.meta.startedAt * 1000)}</span>
                </div>
              </button>
            );
          })
        )}
      </Card>
    </section>
  );
}
