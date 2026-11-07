"use client";

import { ExternalLink, FolderGit2, Pencil, Play, Plus, RefreshCw, RotateCw, ScrollText, Square, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useCluster } from "@/components/cluster";
import { PageHero } from "@/components/page-hero";
import { Drawer } from "@/components/drawer";
import { Badge, Button, Card, Empty, Field, Output, StatusDot, cx, inputCls, serviceTone } from "@/components/ui";
import { api } from "@/lib/client";
import { timeAgo, vmState } from "@/lib/format";
import type { JobStartResult, ProjectManifest, ProjectState, PublishedPort } from "@/lib/types";

interface Instance {
  vm: string;
  state: ProjectState;
  url: string | null;
}

interface FormState {
  name: string;
  repo: string;
  branch: string;
  install: string;
  build: string;
  start: string;
  port: string;
  publish: boolean;
  access: "public" | "private";
  env: string;
  targets: string[];
  createdAt?: string;
  envKeys?: string[];
  editing: boolean;
}

const PRESETS: { label: string; hint: string; values: Partial<FormState> }[] = [
  {
    label: "Next.js app",
    hint: "Website or full-stack app",
    values: { install: "npm ci || npm install", build: "npm run build", start: "npm run start -- -p $PORT", port: "3000", publish: true, access: "public", env: "" },
  },
  {
    label: "Node API",
    hint: "Express, Fastify, Nest…",
    values: { install: "npm ci || npm install", build: "", start: "npm start", port: "3000", publish: true, access: "public", env: "" },
  },
  {
    label: "Static site / web game",
    hint: "Vite, React, HTML5 games",
    values: { install: "npm ci || npm install", build: "npm run build", start: "npx --yes serve -s dist -l $PORT", port: "8080", publish: true, access: "public", env: "" },
  },
  {
    label: "Python API",
    hint: "FastAPI / Flask",
    values: {
      install: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
      build: "",
      start: ".venv/bin/uvicorn main:app --host 0.0.0.0 --port $PORT",
      port: "8000",
      publish: true,
      access: "public",
      env: "",
    },
  },
  {
    label: "AI agent / worker",
    hint: "Background Python process, no web port",
    values: { install: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt", build: "", start: ".venv/bin/python main.py", port: "", publish: false, access: "private", env: "" },
  },
  {
    label: "Local AI model (Ollama)",
    hint: "Runs a model on the machine; private link",
    values: {
      repo: "",
      install: "command -v ollama >/dev/null || (curl -fsSL https://ollama.com/install.sh | sh && sudo systemctl disable --now ollama 2>/dev/null || true)",
      build: "OLLAMA_HOST=127.0.0.1:11500 ollama serve >/dev/null 2>&1 & pid=$!; sleep 5; OLLAMA_HOST=127.0.0.1:11500 ollama pull \"${MODEL:-llama3.2:3b}\"; kill $pid",
      start: "OLLAMA_HOST=0.0.0.0:$PORT exec ollama serve",
      port: "11434",
      publish: true,
      access: "private",
      env: "MODEL=llama3.2:3b",
    },
  },
  {
    label: "PostgreSQL",
    hint: "Docker, data kept in ~/data, never public",
    values: {
      repo: "",
      install: "mkdir -p ~/data/postgres",
      build: "docker pull postgres:17",
      start: "docker rm -f pg-$PORT >/dev/null 2>&1; exec docker run --name pg-$PORT -p 127.0.0.1:$PORT:5432 -e POSTGRES_PASSWORD -v $HOME/data/postgres:/var/lib/postgresql/data postgres:17",
      port: "5432",
      publish: false,
      access: "private",
      env: "POSTGRES_PASSWORD=change-me",
    },
  },
  {
    label: "Redis",
    hint: "Docker, persistent, never public",
    values: {
      repo: "",
      install: "mkdir -p ~/data/redis",
      build: "docker pull redis:7",
      start: "docker rm -f redis-$PORT >/dev/null 2>&1; exec docker run --name redis-$PORT -p 127.0.0.1:$PORT:6379 -v $HOME/data/redis:/data redis:7 redis-server --appendonly yes",
      port: "6379",
      publish: false,
      access: "private",
      env: "",
    },
  },
  {
    label: "Any Docker image",
    hint: "Edit the image and container port",
    values: {
      repo: "",
      install: "",
      build: "docker pull nginx:alpine",
      start: "docker rm -f app-$PORT >/dev/null 2>&1; exec docker run --name app-$PORT -p $PORT:80 nginx:alpine",
      port: "8080",
      publish: true,
      access: "public",
      env: "",
    },
  },
  {
    label: "Docker Compose",
    hint: "Repo with a compose file",
    values: { install: "", build: "docker compose build", start: "exec docker compose up", port: "8080", publish: true, access: "public", env: "" },
  },
];

const blank = (targets: string[]): FormState => ({
  name: "",
  repo: "",
  branch: "main",
  install: "npm ci || npm install",
  build: "npm run build",
  start: "npm run start -- -p $PORT",
  port: "3000",
  publish: true,
  access: "public",
  env: "",
  targets,
  editing: false,
});

function urlFor(m: ProjectManifest, ports: PublishedPort[], saved?: string | null): string | null {
  if (saved) return saved;
  if (!m.port) return null;
  return ports.find((p) => p.port === m.port)?.url ?? null;
}

export default function ProjectsPage() {
  const { vms, status, checking, openJob, refresh } = useCluster();
  const [form, setForm] = useState<FormState | null>(null);
  const [logs, setLogs] = useState<{ vm: string; name: string; text: string; loading: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projects = useMemo(() => {
    const map = new Map<string, Instance[]>();
    for (const v of vms) {
      const a = status[v.name]?.agent;
      for (const p of a?.projects ?? []) {
        const list = map.get(p.manifest.name) ?? [];
        list.push({ vm: v.name, state: p, url: urlFor(p.manifest, a?.ports ?? [], p.url) });
        map.set(p.manifest.name, list);
      }
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [vms, status]);

  const act = async (vm: string, name: string, action: string) => {
    if (action === "remove" && !confirm(`Remove ${name} from ${vm}? This stops it and deletes its files on the VM.`)) return;
    setBusy(`${vm}:${name}:${action}`);
    setError(null);
    try {
      if (action === "logs") {
        setLogs({ vm, name, text: "", loading: true });
        const { output } = await api<{ output: string }>("/api/projects/action", { vm, name, action });
        setLogs({ vm, name, text: output, loading: false });
      } else if (action === "deploy") {
        const { jobId } = await api<{ jobId: string }>("/api/projects/action", { vm, name, action });
        openJob({ vm, id: jobId, title: `deploy ${name}` });
      } else {
        await api("/api/projects/action", { vm, name, action });
        await refresh([vm]);
      }
    } catch (e) {
      setError(`${vm} · ${name}: ${(e as Error).message}`);
      if (action === "logs") setLogs(null);
    } finally {
      setBusy(null);
    }
  };

  const edit = (name: string, instances: Instance[]) => {
    const m = instances[0].state.manifest;
    setForm({
      name,
      repo: m.repo,
      branch: m.branch,
      install: m.install,
      build: m.build,
      start: m.start,
      port: m.port ? String(m.port) : "",
      publish: m.publish,
      access: m.access ?? "public",
      env: "",
      envKeys: m.envKeys,
      targets: instances.map((i) => i.vm),
      createdAt: m.createdAt,
      editing: true,
    });
  };

  const onlineNames = vms.filter((v) => status[v.name]?.ok).map((v) => v.name);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-8 py-6">
      <PageHero
        eyebrow="Apps, APIs, databases, models"
        title="Projects"
        icon={<FolderGit2 className="size-6" />}
        desc="Deploy any repo or container to any machines. Each runs as a service that restarts on crash, with an optional public or private HTTPS link."
        actions={
          <Button variant="primary" onClick={() => setForm(blank(onlineNames.slice(0, 1)))}>
            <Plus className="size-4" /> New project
          </Button>
        }
      />

      {error && <pre className="rounded-md bg-rose-950/30 p-3 text-xs whitespace-pre-wrap text-rose-300">{error}</pre>}

      {projects.length === 0 ? (
        <Card>
          <Empty icon={<FolderGit2 className="size-8" />} title="No projects deployed yet">
            Click <b className="text-zinc-300">New project</b>, paste a public git URL, pick a preset and the VMs to run it on.
          </Empty>
        </Card>
      ) : (
        <div className="space-y-4">
          {projects.map(([name, instances]) => {
            const m = instances[0].state.manifest;
            return (
              <Card key={name} className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderGit2 className="size-4 text-zinc-500" />
                      <span className="font-semibold">{name}</span>
                      {m.port && <Badge>:{m.port}</Badge>}
                      <Badge tone="blue">
                        {instances.length} VM{instances.length > 1 ? "s" : ""}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                      {m.repo ? `${m.repo} @ ${m.branch}` : "no repo"} · start: {m.start || "(none)"}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => edit(name, instances)}>
                    <Pencil className="size-3.5" /> Edit / scale
                  </Button>
                </div>
                <ul className="divide-y divide-[var(--line)]">
                  {instances.map((i) => {
                    const key = (a: string) => busy === `${i.vm}:${name}:${a}`;
                    const isActive = i.state.active === "active";
                    return (
                      <li key={i.vm} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                        <div className="flex min-w-0 items-center gap-3 text-xs">
                          <StatusDot state={vmState(status[i.vm], Boolean(checking[i.vm]))} />
                          <span className="w-14 font-mono text-zinc-300">{i.vm}</span>
                          <Badge tone={serviceTone(i.state.active)}>{i.state.active}</Badge>
                          <span className="hidden text-zinc-500 sm:inline">deployed {timeAgo(i.state.deployedAt ? i.state.deployedAt * 1000 : null)}</span>
                          {i.url && (
                            <a href={i.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-sky-300 hover:underline">
                              {i.url.replace(/^https:\/\//, "")}
                              <ExternalLink className="size-3" />
                            </a>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant="ghost" onClick={() => act(i.vm, name, "deploy")} loading={key("deploy")} title="Pull latest code, rebuild, restart">
                            <RefreshCw className="size-3.5" /> Redeploy
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => act(i.vm, name, "restart")} loading={key("restart")}>
                            <RotateCw className="size-3.5" /> Restart
                          </Button>
                          {isActive ? (
                            <Button size="sm" variant="ghost" onClick={() => act(i.vm, name, "stop")} loading={key("stop")}>
                              <Square className="size-3.5" /> Stop
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => act(i.vm, name, "start")} loading={key("start")}>
                              <Play className="size-3.5" /> Start
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => act(i.vm, name, "logs")} loading={key("logs")}>
                            <ScrollText className="size-3.5" /> Logs
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => act(i.vm, name, "remove")} loading={key("remove")} className="hover:text-rose-300">
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}
        </div>
      )}

      {form && (
        <ProjectForm
          initial={form}
          onClose={() => setForm(null)}
          onDeployed={(jobs) => {
            setForm(null);
            const first = jobs.find((j) => j.id);
            if (first?.id) openJob({ vm: first.vm, id: first.id, title: `deploy ${form.name || "project"}` });
            const failed = jobs.filter((j) => j.error);
            if (failed.length) setError(failed.map((j) => `${j.vm}: ${j.error}`).join("\n"));
            void refresh(jobs.map((j) => j.vm));
          }}
        />
      )}

      {logs && (
        <Drawer
          title={`${logs.name} logs`}
          subtitle={<span className="font-mono">{logs.vm} · last 300 lines</span>}
          actions={
            <Button size="sm" onClick={() => act(logs.vm, logs.name, "logs")} loading={logs.loading}>
              <RefreshCw className="size-3.5" /> Reload
            </Button>
          }
          onClose={() => setLogs(null)}
        >
          {logs.loading && !logs.text ? <p className="text-sm text-zinc-500">Loading…</p> : <Output text={logs.text} className="max-h-none" />}
        </Drawer>
      )}
    </div>
  );
}

function ProjectForm({
  initial,
  onClose,
  onDeployed,
}: {
  initial: FormState;
  onClose: () => void;
  onDeployed: (jobs: JobStartResult[]) => void;
}) {
  const { vms, status, checking } = useCluster();
  const [f, setF] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { jobs } = await api<{ jobs: JobStartResult[] }>("/api/projects", {
        targets: f.targets,
        name: f.name,
        repo: f.repo,
        branch: f.branch,
        install: f.install,
        build: f.build,
        start: f.start,
        port: f.port ? Number(f.port) : null,
        publish: f.publish,
        access: f.access,
        env: f.editing && !f.env.trim() ? null : f.env,
        createdAt: f.createdAt,
      });
      onDeployed(jobs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer title={f.editing ? `Edit ${f.name}` : "New project"} subtitle="Saving deploys to every selected VM as a background job." onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {!f.editing && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Start from</p>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  onClick={() => setF((s) => ({ ...s, ...p.values }))}
                  className="rounded-xl border border-line-strong px-3 py-2 text-left hover:border-accent/60 hover:bg-white/[0.03]"
                >
                  <span className="block text-sm font-medium text-white">{p.label}</span>
                  <span className="block text-[11px] text-muted">{p.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="lowercase, digits, dashes">
            <input
              required
              disabled={f.editing}
              value={f.name}
              onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              className={inputCls}
              placeholder="my-app"
            />
          </Field>
          <Field label="Branch">
            <input value={f.branch} onChange={(e) => set("branch", e.target.value)} className={inputCls} />
          </Field>
        </div>
        <Field label="Git repository (optional)" hint="Leave empty for Docker images and models. Private repo: https://<token>@github.com/user/repo.git">
          <input value={f.repo} onChange={(e) => set("repo", e.target.value.trim())} className={cx(inputCls, "font-mono")} placeholder="https://github.com/user/repo.git" />
        </Field>
        <Field label="Install command">
          <input value={f.install} onChange={(e) => set("install", e.target.value)} className={cx(inputCls, "font-mono")} />
        </Field>
        <Field label="Build command">
          <input value={f.build} onChange={(e) => set("build", e.target.value)} className={cx(inputCls, "font-mono")} />
        </Field>
        <Field label="Start command" hint="Runs as a service with $PORT set. Leave empty for build-only projects.">
          <input value={f.start} onChange={(e) => set("start", e.target.value)} className={cx(inputCls, "font-mono")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Port">
            <input value={f.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} className={inputCls} placeholder="3000" />
          </Field>
          <Field label="Link">
            <select
              value={!f.publish ? "none" : f.access}
              onChange={(e) => setF((s) => ({ ...s, publish: e.target.value !== "none", access: e.target.value === "private" ? "private" : "public" }))}
              className={inputCls}
            >
              <option value="public">Public HTTPS link (websites, APIs)</option>
              <option value="private">Private link with secret token (models, admin tools)</option>
              <option value="none">No link (databases, workers)</option>
            </select>
          </Field>
        </div>
        <Field
          label="Environment variables"
          hint={
            f.editing
              ? `Leave empty to keep the current ones${f.envKeys?.length ? ` (${f.envKeys.join(", ")})` : ""}. Anything you enter replaces them all.`
              : "One KEY=value per line. Stored on the VM only, readable by its owner only."
          }
        >
          <textarea
            value={f.env}
            onChange={(e) => set("env", e.target.value)}
            rows={4}
            spellCheck={false}
            className={cx(inputCls, "font-mono text-xs")}
            placeholder={"DATABASE_URL=postgres://…\nNODE_ENV=production"}
          />
        </Field>
        <Field label="Deploy to">
          <div className="flex flex-wrap gap-1.5">
            {vms.map((v) => {
              const on = f.targets.includes(v.name);
              return (
                <button
                  type="button"
                  key={v.name}
                  onClick={() => set("targets", on ? f.targets.filter((t) => t !== v.name) : [...f.targets, v.name])}
                  className={cx(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs",
                    on ? "border-[var(--accent)]/70 bg-[var(--accent)]/15 text-ink" : "border-[var(--line-strong)] text-zinc-400",
                  )}
                >
                  <StatusDot state={vmState(status[v.name], Boolean(checking[v.name]))} />
                  {v.name}
                </button>
              );
            })}
          </div>
        </Field>
        {error && <p className="text-sm text-rose-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!f.name || !f.targets.length}>
            {f.editing ? "Save & redeploy" : "Deploy"} to {f.targets.length} VM{f.targets.length === 1 ? "" : "s"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
