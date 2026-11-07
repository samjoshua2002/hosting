"use client";

import { ExternalLink, FolderGit2, Pencil, Play, Plus, RefreshCw, RotateCw, ScrollText, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useCluster } from "@/components/cluster";
import { PageHero } from "@/components/page-hero";
import { Drawer } from "@/components/drawer";
import { ProjectForm, blank, urlFor, type FormState } from "@/components/project-form";
import { Badge, Button, Card, Empty, Output, StatusDot, serviceTone } from "@/components/ui";
import { api } from "@/lib/client";
import { timeAgo, vmState } from "@/lib/format";
import type { ProjectState } from "@/lib/types";

interface Instance {
  vm: string;
  state: ProjectState;
  url: string | null;
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
      category: m.category ?? "app",
      env: "",
      envKeys: m.envKeys,
      targets: instances.map((i) => i.vm),
      createdAt: m.createdAt,
      editing: true,
    });
  };

  const onlineNames = vms.filter((v) => status[v.name]?.ok).map((v) => v.name);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
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
                      <Link href={`/projects/${name}`} className="font-semibold text-white hover:text-accent-soft hover:underline">{name}</Link>
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
