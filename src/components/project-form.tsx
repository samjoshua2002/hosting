"use client";

import { GitBranch, Lock, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client";
import { vmState } from "@/lib/format";
import { repoFromUrl } from "@/lib/github-shared";
import { rankMachines } from "@/lib/placement";
import { projectType, typeFields, TYPE_LABEL, TYPE_ORDER, type ProjectType } from "@/lib/project-type";
import type { GithubLink, JobStartResult, ProjectManifest, PublishedPort } from "@/lib/types";
import { useCluster } from "./cluster";
import { Drawer } from "./drawer";
import { GithubConnect, GithubMark, RepoPicker, useGithub, type Repo } from "./github";
import { Button, Field, StatusDot, cx, inputCls } from "./ui";

export interface FormState {
  name: string;
  repo: string;
  branch: string;
  install: string;
  build: string;
  start: string;
  port: string;
  publish: boolean;
  access: "public" | "private";
  type: ProjectType;
  framework: string;
  github: GithubLink | null;
  env: string;
  targets: string[];
  createdAt?: string;
  envKeys?: string[];
  editing: boolean;
}

export const PRESETS: { label: string; hint: string; values: Partial<FormState> }[] = [
  {
    label: "Next.js app",
    hint: "Website or full-stack app",
    values: { type: "website", install: "npm ci || npm install", build: "npm run build", start: "npm run start -- -p $PORT", port: "3000", publish: true, access: "public", env: "" },
  },
  {
    label: "Node API",
    hint: "Express, Fastify, Nest…",
    values: { type: "service", install: "npm ci || npm install", build: "", start: "npm start", port: "3000", publish: true, access: "public", env: "" },
  },
  {
    label: "Static site / web game",
    hint: "Vite, React, HTML5 games",
    values: { type: "website", install: "npm ci || npm install", build: "npm run build", start: "npx --yes serve -s dist -l $PORT", port: "8080", publish: true, access: "public", env: "" },
  },
  {
    label: "Python API",
    hint: "FastAPI / Flask",
    values: { type: "service",
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
    values: { type: "worker", install: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt", build: "", start: ".venv/bin/python main.py", port: "", publish: false, access: "private", env: "" },
  },
  {
    label: "Local AI model (Ollama)",
    hint: "Runs a model on the machine; private link",
    values: { type: "service",
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
    values: { type: "database",
      repo: "",
      install: "mkdir -p ~/data/postgres",
      build: "docker pull postgres:17",
      start: "docker rm -f pg-$PORT >/dev/null 2>&1; exec docker run --name pg-$PORT -p 127.0.0.1:$PORT:5432 -e POSTGRES_PASSWORD -v $HOME/data/postgres:/var/lib/postgresql/data postgres:17",
      port: "5432",
      publish: false,
      access: "private",
      env: "POSTGRES_PASSWORD=generate",
    },
  },
  {
    label: "Redis",
    hint: "Docker, persistent, never public",
    values: { type: "database",
      repo: "",
      install: "mkdir -p ~/data/redis",
      build: "docker pull redis:7",
      start: "docker rm -f redis-$PORT >/dev/null 2>&1; exec docker run --name redis-$PORT -p 127.0.0.1:$PORT:6379 -v $HOME/data/redis:/data redis:7 redis-server --appendonly yes --requirepass \"$REDIS_PASSWORD\"",
      port: "6379",
      publish: false,
      access: "private",
      env: "REDIS_PASSWORD=generate",
    },
  },
  {
    label: "MongoDB",
    hint: "Docker, data kept in ~/data, never public",
    values: { type: "database",
      repo: "",
      install: "mkdir -p ~/data/mongo",
      build: "docker pull mongo:8",
      start:
        "docker rm -f mongo-$PORT >/dev/null 2>&1; exec docker run --name mongo-$PORT -p 127.0.0.1:$PORT:27017 -e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD -v $HOME/data/mongo:/data/db mongo:8",
      port: "27017",
      publish: false,
      access: "private",
      env: "MONGO_INITDB_ROOT_PASSWORD=generate",
    },
  },
  {
    label: "MySQL",
    hint: "Docker, data kept in ~/data, never public",
    values: { type: "database",
      repo: "",
      install: "mkdir -p ~/data/mysql",
      build: "docker pull mysql:8.4",
      start: "docker rm -f mysql-$PORT >/dev/null 2>&1; exec docker run --name mysql-$PORT -p 127.0.0.1:$PORT:3306 -e MYSQL_ROOT_PASSWORD -v $HOME/data/mysql:/var/lib/mysql mysql:8.4",
      port: "3306",
      publish: false,
      access: "private",
      env: "MYSQL_ROOT_PASSWORD=generate",
    },
  },
  {
    label: "pgAdmin",
    hint: "Web UI for Postgres on the same machine; private link",
    values: { type: "tool",
      repo: "",
      install: "mkdir -p ~/data/pgadmin && sudo chown -R 5050:5050 ~/data/pgadmin",
      build: "docker pull dpage/pgadmin4",
      start:
        "docker rm -f pgadmin-$PORT >/dev/null 2>&1; exec docker run --name pgadmin-$PORT --network host -e PGADMIN_LISTEN_PORT=$PORT -e PGADMIN_DEFAULT_EMAIL -e PGADMIN_DEFAULT_PASSWORD -v $HOME/data/pgadmin:/var/lib/pgadmin dpage/pgadmin4",
      port: "5050",
      publish: true,
      access: "private",
      env: "PGADMIN_DEFAULT_EMAIL=admin@hosting.dev\nPGADMIN_DEFAULT_PASSWORD=generate",
    },
  },
  {
    label: "Adminer",
    hint: "Web UI for MySQL & Postgres on the same machine; private link",
    values: {
      type: "tool",
      repo: "",
      install: "",
      build: "docker pull adminer",
      start: "docker rm -f adminer-$PORT >/dev/null 2>&1; exec docker run --name adminer-$PORT --network host -e ADMINER_DEFAULT_SERVER=127.0.0.1 adminer php -S 0.0.0.0:$PORT -t /var/www/html",
      port: "8080",
      publish: true,
      access: "private",
      env: "",
    },
  },
  {
    label: "Any Docker image",
    hint: "Edit the image and container port",
    values: { type: "website",
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
    values: { type: "service", install: "", build: "docker compose build", start: "exec docker compose up", port: "8080", publish: true, access: "public", env: "" },
  },
];

export const blank = (targets: string[]): FormState => ({
  name: "",
  repo: "",
  branch: "main",
  install: "npm ci || npm install",
  build: "npm run build",
  start: "npm run start -- -p $PORT",
  port: "3000",
  publish: true,
  access: "public",
  type: "website",
  framework: "",
  github: null,
  env: "",
  targets,
  editing: false,
});

/** The edit form for an existing project. */
export function formFromManifest(m: ProjectManifest, targets: string[]): FormState {
  return {
    name: m.name,
    repo: m.repo,
    branch: m.branch,
    install: m.install,
    build: m.build,
    start: m.start,
    port: m.port ? String(m.port) : "",
    publish: m.publish,
    access: m.access ?? "public",
    type: projectType(m),
    framework: m.framework ?? "",
    github: m.github ?? null,
    env: "",
    envKeys: m.envKeys,
    targets,
    createdAt: m.createdAt,
    editing: true,
  };
}

export function urlFor(m: ProjectManifest, ports: PublishedPort[], saved?: string | null): string | null {
  if (saved) return saved;
  if (!m.port) return null;
  return ports.find((p) => p.port === m.port)?.url ?? null;
}

interface Detect {
  repo: Repo;
  branch: string;
  detected: { framework: string; kind: "website" | "service" | "worker"; install: string; build: string; start: string; port: string; publish: boolean };
}

export function ProjectForm({
  initial,
  importRepo: importFirst,
  onClose,
  onDeployed,
}: {
  initial: FormState;
  /** a repo picked before the form opened: detect it right away */
  importRepo?: Repo;
  onClose: () => void;
  onDeployed: (jobs: JobStartResult[], warning?: string) => void;
}) {
  const { vms, status, checking } = useCluster();
  const gh = useGithub();
  const [f, setF] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const linkable = !f.github && repoFromUrl(f.repo);

  const importRepo = async (r: Repo) => {
    setImporting(r.fullName);
    setError(null);
    try {
      const d = await api<Detect>(`/api/github/detect?repo=${encodeURIComponent(r.fullName)}`);
      const x = d.detected;
      setF((s) => ({
        ...s,
        name: s.name || r.fullName.split("/")[1].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40),
        repo: `https://github.com/${d.repo.fullName}.git`,
        branch: d.branch,
        github: { repo: d.repo.fullName, private: d.repo.private, autoDeploy: true },
        framework: x.framework === "Unknown" ? "" : x.framework,
        type: x.kind,
        targets: rankMachines(vms.map((v) => v.name), status, x.kind, "box5").slice(0, 1),
        install: x.install,
        build: x.build,
        start: x.start,
        port: x.port,
        publish: x.publish,
        access: "public",
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(null);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (!importFirst || started.current) return;
    started.current = true;
    queueMicrotask(() => void importRepo(importFirst));
  }, [importFirst]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { jobs, warning } = await api<{ jobs: JobStartResult[]; warning?: string }>("/api/projects", {
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
        ...typeFields(f.type),
        framework: f.framework,
        github: f.github ? { repo: f.github.repo, autoDeploy: f.github.autoDeploy } : undefined,
        env: f.editing && !f.env.trim() ? null : f.env,
        createdAt: f.createdAt,
      });
      onDeployed(jobs, warning);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const connected = gh.status?.connected;

  return (
    <Drawer title={f.editing ? `Edit ${f.name}` : "New project"} subtitle="Saving deploys to every selected machine as a background job." onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        {f.github ? (
          <div className="rounded-xl border border-line-strong p-3">
            <div className="flex items-center gap-2">
              <GithubMark className="text-white" />
              <span className="truncate text-sm font-medium text-white">{f.github.repo}</span>
              {f.github.private && <Lock className="size-3 text-muted" />}
              <span className="flex items-center gap-1 font-mono text-xs text-muted">
                <GitBranch className="size-3" /> {f.branch}
              </span>
              {f.framework && <span className="rounded bg-chip px-1.5 py-px text-[11px] text-ink">{f.framework}</span>}
              {!f.editing && (
                <button type="button" onClick={() => setF((s) => ({ ...s, github: null, repo: "", framework: "" }))} className="ml-auto text-muted hover:text-white" title="Choose another">
                  <X className="size-4" />
                </button>
              )}
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={f.github.autoDeploy} onChange={(e) => set("github", { ...f.github!, autoDeploy: e.target.checked })} className="accent-[var(--accent)]" />
              Redeploy automatically when I push to <span className="font-mono">{f.branch}</span>
            </label>
          </div>
        ) : !f.editing ? (
          <div>
            <p className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
              <GithubMark /> Import Git repository
            </p>
            {gh.status === null ? (
              <div className="h-24 animate-pulse rounded-xl border border-line-strong" />
            ) : connected ? (
              <RepoPicker onPick={importRepo} busyRepo={importing} />
            ) : showConnect ? (
              <div className="rounded-xl border border-line-strong p-4">
                <GithubConnect />
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line-strong p-4">
                <p className="text-sm text-muted">Connect GitHub to pick a repo, detect its framework, and redeploy on every push.</p>
                <Button type="button" size="sm" onClick={() => setShowConnect(true)}>
                  <GithubMark /> Connect GitHub
                </Button>
              </div>
            )}
          </div>
        ) : linkable && connected ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line-strong p-3">
            <p className="text-sm text-muted">This repo is on GitHub. Redeploy it on every push?</p>
            <Button type="button" size="sm" onClick={() => set("github", { repo: repoFromUrl(f.repo)!, private: false, autoDeploy: true })}>
              <GithubMark /> Turn on auto-deploy
            </Button>
          </div>
        ) : null}

        {!f.editing && !f.github && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Or start from a template</p>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  onClick={() =>
                    setF((s) => ({ ...s, framework: "", ...p.values, targets: rankMachines(vms.map((v) => v.name), status, p.values.type ?? s.type, "box5").slice(0, 1) }))
                  }
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
          <Field label="Type" hint={TYPE_LABEL[f.type].hint}>
            <select
              value={f.type}
              onChange={(e) => {
                const t = e.target.value as ProjectType;
                setF((p) => ({ ...p, type: t, targets: p.editing ? p.targets : rankMachines(vms.map((v) => v.name), status, t, "box5").slice(0, 1) }));
              }}
              className={inputCls}
            >
              {TYPE_ORDER.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t].one}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {!f.github && (
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="Git repository (optional)" hint="Leave empty for Docker images and models.">
              <input value={f.repo} onChange={(e) => set("repo", e.target.value.trim())} className={cx(inputCls, "font-mono")} placeholder="https://github.com/user/repo.git" />
            </Field>
            <Field label="Branch">
              <input value={f.branch} onChange={(e) => set("branch", e.target.value)} className={inputCls} />
            </Field>
          </div>
        )}
        {f.github && (
          <Field label="Branch">
            <input value={f.branch} onChange={(e) => set("branch", e.target.value)} className={inputCls} />
          </Field>
        )}
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
              : "One KEY=value per line, stored on the machine only (owner-readable). Write generate as a value to get a strong random password."
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
        <Field label="Deploy to" hint={f.editing ? undefined : "Picked automatically: the online machine with the most room (databases stay with the other databases). Click to change."}>
          <div className="flex flex-wrap gap-1.5">
            {!f.editing && (
              <button
                type="button"
                onClick={() => set("targets", rankMachines(vms.map((v) => v.name), status, f.type, "box5").slice(0, 1))}
                className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink hover:border-accent/60"
              >
                Auto
              </button>
            )}
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
        {error && <p className="text-sm text-[var(--critical-text)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!f.name || !f.targets.length}>
            {f.editing ? "Save & redeploy" : "Deploy"} to {f.targets.length} machine{f.targets.length === 1 ? "" : "s"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
