"use client";

import { ArrowLeft, ExternalLink, Eye, EyeOff, FolderGit2, Loader2, Pause, Play, RefreshCw, RotateCw, ScrollText, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCluster } from "@/components/cluster";
import { PageHero } from "@/components/page-hero";
import { ProjectForm, formFromManifest, urlFor, type FormState } from "@/components/project-form";
import { Badge, Button, Card, Empty, StatusDot, cx, inputCls, serviceTone } from "@/components/ui";
import { GithubMark } from "@/components/github";
import { api } from "@/lib/client";
import { projectType, TYPE_LABEL } from "@/lib/project-type";
import { fmtDuration, timeAgo, vmState } from "@/lib/format";
import type { JobStartResult, ProjectState } from "@/lib/types";

type Tab = "logs" | "deploys" | "env" | "settings";

export function ProjectView() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();
  const { vms, status, checking, refresh, openJob } = useCluster();
  const [tab, setTab] = useState<Tab>("logs");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormState | null>(null);

  const instances = useMemo(
    () =>
      vms.flatMap((v) => {
        const a = status[v.name]?.agent;
        const p = a?.projects.find((x) => x.manifest.name === name);
        return p ? [{ vm: v.name, state: p, url: urlFor(p.manifest, a?.ports ?? [], p.url) }] : [];
      }),
    [vms, status, name],
  );
  const m = instances[0]?.state.manifest;
  const loaded = vms.length > 0 && vms.every((v) => status[v.name]);

  const act = async (action: string) => {
    if (action === "remove" && !confirm(`Delete ${name} from ${instances.map((i) => i.vm).join(", ")}? This stops it and removes its code and link.`)) return;
    setBusy(action);
    setError(null);
    try {
      if (action === "deploy") {
        let first: { vm: string; id: string } | null = null;
        for (const i of instances) {
          const { jobId } = await api<{ jobId: string }>("/api/projects/action", { vm: i.vm, name, action });
          first ??= { vm: i.vm, id: jobId };
        }
        if (first) openJob({ ...first, title: `deploy ${name}` });
        setTab("deploys");
      } else {
        await Promise.all(instances.map((i) => api("/api/projects/action", { vm: i.vm, name, action })));
        if (action === "remove") return router.push("/projects");
      }
      await refresh(instances.map((i) => i.vm));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const editForm = (): FormState | null => (m ? formFromManifest(m, instances.map((i) => i.vm)) : null);

  if (!m)
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
        <Link href="/projects" className="flex items-center gap-1 text-sm text-muted hover:text-white">
          <ArrowLeft className="size-4" /> Projects
        </Link>
        <Card>
          {loaded ? (
            <Empty icon={<FolderGit2 className="size-8" />} title={`No project called ${name}`}>
              It may have been removed, or its machine is asleep.
            </Empty>
          ) : (
            <p className="flex items-center gap-2 p-8 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
        </Card>
      </div>
    );

  const anyActive = instances.some((i) => i.state.active === "active");

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
      <Link href="/projects" className="flex items-center gap-1 text-sm text-muted hover:text-white">
        <ArrowLeft className="size-4" /> Projects
      </Link>
      <PageHero
        eyebrow={`${TYPE_LABEL[projectType(m)].one}${m.framework ? ` · ${m.framework}` : ""}`}
        title={name}
        icon={m.github ? <GithubMark className="size-6" /> : <FolderGit2 className="size-6" />}
        desc={
          m.github
            ? `${m.github.repo} @ ${m.branch}${m.github.autoDeploy ? " · redeploys on every push" : ""}`
            : m.repo
              ? `${m.repo.replace(/^https:\/\/[^@]*@/, "https://")} @ ${m.branch}`
              : m.start
        }
        actions={
          <>
            <Button variant="primary" onClick={() => act("deploy")} loading={busy === "deploy"} title="Pull the latest code, rebuild and restart">
              <RefreshCw className="size-3.5" /> Deploy
            </Button>
            <Button onClick={() => act("restart")} loading={busy === "restart"}>
              <RotateCw className="size-3.5" /> Restart
            </Button>
            {anyActive ? (
              <Button onClick={() => act("stop")} loading={busy === "stop"}>
                <Square className="size-3.5" /> Stop
              </Button>
            ) : (
              <Button onClick={() => act("start")} loading={busy === "start"}>
                <Play className="size-3.5" /> Start
              </Button>
            )}
            <Button variant="danger" onClick={() => act("remove")} loading={busy === "remove"} title="Delete">
              <Trash2 className="size-3.5" />
            </Button>
          </>
        }
      />
      {error && <p className="rounded-lg border border-[var(--critical)]/40 p-3 text-sm text-[var(--critical-text)]">{error}</p>}

      {/* where it runs */}
      <Card className="divide-y divide-white/[0.06]">
        {instances.map((i) => (
          <div key={i.vm} className="flex items-center gap-4 px-6 py-3 text-sm">
            <StatusDot state={vmState(status[i.vm], Boolean(checking[i.vm]))} />
            <span className="w-16 font-mono text-white">{i.vm}</span>
            <Badge tone={serviceTone(i.state.active)}>{i.state.active}</Badge>
            <span className="text-muted">deployed {timeAgo(i.state.deployedAt ? i.state.deployedAt * 1000 : null)}</span>
            {i.state.commit && (
              <span className="min-w-0 truncate text-muted" title={`${i.state.commit.sha} by ${i.state.commit.author}`}>
                <span className="font-mono text-ink">{i.state.commit.sha.slice(0, 7)}</span> {i.state.commit.message}
              </span>
            )}
            {m.port && <span className="text-muted">port {m.port}</span>}
            <span className="flex-1" />
            {i.url ? (
              <a href={i.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent-soft hover:underline">
                {i.url.replace(/^https:\/\//, "").replace(/\?.*$/, "")}
                {i.url.includes("_token=") && <Badge>private</Badge>}
                <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <span className="text-muted">no link</span>
            )}
          </div>
        ))}
      </Card>

      {/* tabs */}
      <div className="flex gap-1 border-b border-white/[0.06]">
        {(
          [
            ["logs", "Logs"],
            ["deploys", "Deploys"],
            ["env", "Environment"],
            ["settings", "Settings"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cx("-mb-px border-b-2 px-4 py-2 text-sm transition-colors", tab === id ? "border-accent text-white" : "border-transparent text-muted hover:text-white")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "logs" && <Logs name={name} vms={instances.map((i) => i.vm)} />}
      {tab === "deploys" && <Deploys name={name} vms={instances.map((i) => i.vm)} />}
      {tab === "env" && <Env name={name} instances={instances} />}
      {tab === "settings" && (
        <Card className="p-6">
          <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-y-3 text-sm">
            {(
              [
                ["Repository", m.repo || "—"],
                ["Branch", m.branch],
                ["Install", m.install || "—"],
                ["Build", m.build || "—"],
                ["Start", m.start || "—"],
                ["Port", m.port ? String(m.port) : "—"],
                ["Link", m.publish ? (m.access === "private" ? "private (token)" : "public") : "none"],
                ["Type", `${TYPE_LABEL[projectType(m)].one}${m.framework ? ` (${m.framework})` : ""}`],
                ["GitHub", m.github ? `${m.github.repo}${m.github.private ? " (private)" : ""} · auto-deploy ${m.github.autoDeploy ? "on" : "off"}` : "not linked"],
                ["Machines", instances.map((i) => i.vm).join(", ")],
                ["Created", new Date(m.createdAt).toLocaleString()],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="font-mono text-[13px] break-all text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-6">
            <Button onClick={() => setEditing(editForm())}>Edit settings or machines</Button>
          </div>
        </Card>
      )}

      {editing && (
        <ProjectForm
          initial={editing}
          onClose={() => setEditing(null)}
          onDeployed={(jobs: JobStartResult[], warning?: string) => {
            setEditing(null);
            setError(warning ?? null);
            const first = jobs.find((j) => j.id);
            if (first?.id) openJob({ vm: first.vm, id: first.id, title: `deploy ${name}` });
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Logs({ name, vms }: { name: string; vms: string[] }) {
  const [vm, setVm] = useState(vms[0]);
  const [text, setText] = useState("");
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const { output } = await api<{ output: string }>("/api/projects/action", { vm, name, action: "logs" });
      setText(output);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [vm, name]);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (alive && live) t = setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [load, live]);

  useEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-[hsl(var(--h)_30%_4%)]">
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2 text-xs">
        {vms.length > 1 &&
          vms.map((v) => (
            <button key={v} onClick={() => setVm(v)} className={cx("rounded-md px-2 py-0.5 font-mono", v === vm ? "bg-accent/20 text-ink ring-1 ring-accent/50" : "text-muted hover:text-white")}>
              {v}
            </button>
          ))}
        <span className="text-muted">last 300 lines</span>
        <span className="flex-1" />
        <button onClick={() => setLive((l) => !l)} className="flex items-center gap-1 text-muted hover:text-white">
          {live ? (
            <>
              <Pause className="size-3.5" /> live
            </>
          ) : (
            <>
              <Play className="size-3.5" /> paused
            </>
          )}
        </button>
      </div>
      <pre
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="scroll-thin h-[52vh] overflow-auto px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-zinc-200"
      >
        {error ? <span className="text-[var(--critical-text)]">{error}</span> : text || "Loading…"}
      </pre>
    </div>
  );
}

function Deploys({ name, vms }: { name: string; vms: string[] }) {
  const { status, openJob } = useCluster();
  const deploys = vms
    .flatMap((vm) => (status[vm]?.agent?.jobs ?? []).filter((j) => j.meta.kind === "deploy" && j.meta.project === name).map((j) => ({ ...j, vm })))
    .sort((a, b) => b.meta.startedAt - a.meta.startedAt);
  return (
    <Card className="overflow-hidden">
      {deploys.length === 0 ? (
        <p className="p-6 text-sm text-muted">No recent deploys (each machine keeps its last 40 jobs).</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/[0.06] text-xs text-muted">
            <tr>
              <th className="px-6 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Machine</th>
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 font-medium">Took</th>
              <th className="px-6 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {deploys.map((d) => (
              <tr key={`${d.vm}-${d.id}`} className="hover:bg-white/[0.02]">
                <td className="px-6 py-2.5">
                  {d.state === "running" ? (
                    <Badge tone="amber">
                      <Loader2 className="size-3 animate-spin" /> deploying
                    </Badge>
                  ) : d.state === "done" ? (
                    <Badge tone={d.exitCode === 0 ? "green" : "red"}>{d.exitCode === 0 ? "live" : `failed (exit ${d.exitCode})`}</Badge>
                  ) : (
                    <Badge>interrupted</Badge>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-ink">{d.vm}</td>
                <td className="px-3 py-2.5 text-muted">{timeAgo(d.meta.startedAt * 1000)}</td>
                <td className="px-3 py-2.5 text-muted">{d.endedAt ? fmtDuration(d.endedAt - d.meta.startedAt) : "—"}</td>
                <td className="px-6 py-2.5 text-right">
                  <Button size="sm" variant="ghost" onClick={() => openJob({ vm: d.vm, id: d.id, title: `deploy ${name}` })}>
                    <ScrollText className="size-3.5" /> Log
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Env({ name, instances }: { name: string; instances: { vm: string; state: ProjectState }[] }) {
  const { openJob, refresh } = useCluster();
  const [env, setEnv] = useState<{ key: string; value: string }[] | null>(null);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vm = instances[0].vm;

  useEffect(() => {
    api<{ env: { key: string; value: string }[] }>("/api/projects/action", { vm, name, action: "env" })
      .then((r) => setEnv(r.env))
      .catch((e) => setError((e as Error).message));
  }, [vm, name]);

  const save = async () => {
    if (draft === null) return;
    const m = instances[0].state.manifest;
    setSaving(true);
    setError(null);
    try {
      const { jobs } = await api<{ jobs: JobStartResult[] }>("/api/projects", {
        targets: instances.map((i) => i.vm),
        name,
        repo: m.repo,
        branch: m.branch,
        install: m.install,
        build: m.build,
        start: m.start,
        port: m.port,
        publish: m.publish,
        access: m.access ?? "public",
        category: m.category ?? "app",
        env: draft,
        createdAt: m.createdAt,
      });
      const first = jobs.find((j) => j.id);
      if (first?.id) openJob({ vm: first.vm, id: first.id, title: `deploy ${name}` });
      setDraft(null);
      const r = await api<{ env: { key: string; value: string }[] }>("/api/projects/action", { vm, name, action: "env" });
      setEnv(r.env);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      {error && <p className="mb-3 text-sm text-[var(--critical-text)]">{error}</p>}
      {draft !== null ? (
        <>
          <p className="mb-2 text-xs text-muted">One KEY=value per line. Write generate as a value for a new random password. Saving redeploys on every machine.</p>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} spellCheck={false} className={cx(inputCls, "font-mono text-xs")} />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving}>
              Save &amp; redeploy
            </Button>
          </div>
        </>
      ) : env === null ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : (
        <>
          {env.length === 0 ? (
            <p className="text-sm text-muted">No environment variables.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-white/[0.05]">
                {env.map((e) => (
                  <tr key={e.key}>
                    <td className="w-1/3 py-2 pr-4 font-mono text-ink">{e.key}</td>
                    <td className="py-2 font-mono text-ink/80">
                      <span className="break-all">{shown[e.key] ? e.value : "•".repeat(Math.min(16, Math.max(6, e.value.length)))}</span>
                    </td>
                    <td className="w-10 py-2 text-right">
                      <button onClick={() => setShown((s) => ({ ...s, [e.key]: !s[e.key] }))} className="text-muted hover:text-white" aria-label="Show value">
                        {shown[e.key] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-4">
            <Button onClick={() => setDraft(env.map((e) => `${e.key}=${e.value}`).join("\n"))}>Edit environment</Button>
          </div>
        </>
      )}
    </Card>
  );
}
