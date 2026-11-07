"use client";

import { Container, Cpu, Database, EllipsisVertical, ExternalLink, Folder, FolderGit2, GitBranch, Globe, Lock, Plus, Search, Server, Wrench, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCluster } from "@/components/cluster";
import { Drawer } from "@/components/drawer";
import { GithubConnect, GithubMark, RepoPicker, useGithub, type Repo } from "@/components/github";
import { PageHero } from "@/components/page-hero";
import { PRESETS, ProjectForm, blank, formFromManifest, urlFor, type FormState } from "@/components/project-form";
import { Button, Card, cx } from "@/components/ui";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import { projectType, TYPE_LABEL, TYPE_ORDER, type ProjectType } from "@/lib/project-type";
import type { CommitInfo, JobStartResult, ProjectManifest, ProjectState, VmStatus } from "@/lib/types";

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
  ok: "bg-accent shadow-[0_0_8px_var(--glow)]",
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
  const groups = filter === "all" && !q.trim() ? TYPE_ORDER.map((t) => [t, shown.filter((p) => p.type === t)] as const).filter(([, l]) => l.length) : null;

  const onlineNames = vms.filter((v) => status[v.name]?.ok).map((v) => v.name);
  const newProject = (extra?: Partial<FormState>, importRepo?: Repo) => setForm({ state: { ...blank(onlineNames.slice(0, 1)), ...extra }, importRepo });

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

      {projects.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-line-strong bg-panel/80 px-3 focus-within:border-accent/60">
            <Search className="size-4 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects, repos, frameworks…" className="w-full bg-transparent text-sm text-white outline-none placeholder:text-muted" />
          </label>
          <div className="flex h-10 items-center gap-0.5 rounded-lg border border-line-strong bg-panel/80 p-1">
            {(["all", ...TYPE_ORDER.filter((t) => counts[t])] as const).map((t) => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={cx("h-full rounded-md px-3 text-sm transition-colors", filter === t ? "bg-chip text-white" : "text-muted hover:text-white")}
              >
                {t === "all" ? "All" : TYPE_LABEL[t].many}
                <span className="ml-1.5 text-xs text-muted">{t === "all" ? projects.length : counts[t]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {projects.length === 0 && vms.some((v) => checking[v.name] || !status[v.name]) ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
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
      ) : groups ? (
        groups.map(([t, list]) => (
          <section key={t}>
            <h2 className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold tracking-tight text-white">
              {TYPE_LABEL[t].many}
              <span className="text-sm font-normal text-muted">
                {list.length} · {TYPE_LABEL[t].hint}
              </span>
            </h2>
            <Grid list={list} status={status} onAct={actAll} onEdit={(p) => setForm({ state: formFromManifest(p.m, p.instances.map((i) => i.vm)) })} />
          </section>
        ))
      ) : shown.length ? (
        <Grid list={shown} status={status} onAct={actAll} onEdit={(p) => setForm({ state: formFromManifest(p.m, p.instances.map((i) => i.vm)) })} />
      ) : (
        <p className="py-10 text-center text-sm text-muted">No projects match.</p>
      )}

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
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
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
    <div className="grid grid-cols-2 gap-6">
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
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.slice(0, 10).map((t) => (
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
