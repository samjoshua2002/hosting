"use client";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowRight, Cpu, Database, ExternalLink, GitBranch, Globe, Loader2, Lock, Maximize2, Minimize2, Play, Plug, RefreshCw, RotateCw, ScrollText, SendHorizonal, Server, Settings2, Sparkles, Square, Trash2, Unplug, Wrench, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { shortLabel, shortLink } from "@/lib/short-link";
import { timeAgo } from "@/lib/format";
import { projectType, TYPE_LABEL, type ProjectType } from "@/lib/project-type";
import type { ProjectManifest, ProjectState, VmStatus } from "@/lib/types";
import { ensureDoc, getDoc, newId, openSession, send, stop, updateItems, useAssistant } from "./assistant-store";
import { ArtifactView } from "./artifact-view";
import { CopyButton } from "./chat-blocks";
import { ChatItems } from "./chat-items";
import { useCluster } from "./cluster";
import { contextFor, entitiesFrom } from "./composer";
import { Drawer } from "./drawer";
import { GithubMark } from "./github";
import { Button, Output, cx } from "./ui";

const ICON: Record<ProjectType, LucideIcon> = { website: Globe, service: Server, worker: Cpu, database: Database, tool: Wrench };
const SIZE = { repo: { w: 220, h: 56 }, proj: { w: 260, h: 98 } };

type Tone = "ok" | "busy" | "bad" | "off";
interface Inst {
  vm: string;
  p: ProjectState;
  deploying: boolean;
}
interface Proj {
  name: string;
  m: ProjectManifest;
  type: ProjectType;
  inst: Inst[];
  url: string | null;
  tone: Tone;
  label: string;
}
type RepoData = { repo: string; branch: string; auto: boolean; projects: string[] };
type ProjData = { name: string; type: ProjectType; tone: Tone; label: string; sub: string; locked: boolean; machines: string[]; framework?: string; selected: boolean };
type RepoNode = Node<RepoData, "repo">;
type ProjNode = Node<ProjData, "proj">;
type AnyNode = RepoNode | ProjNode;
type RelEdge = Edge<{ label: string; tone: "deploy" | "uses" | "manual"; busy: boolean }, "rel">;

const DOT: Record<Tone, string> = {
  ok: "bg-[var(--good)]",
  busy: "bg-accent animate-pulse-dot",
  bad: "bg-[var(--critical)]",
  off: "bg-[var(--others)]",
};

function health(inst: Inst[], m: ProjectManifest): { tone: Tone; label: string } {
  const s = inst.map((i) => i.p.active);
  if (inst.some((i) => i.deploying)) return { tone: "busy", label: "Building" };
  if (s.includes("failed")) return { tone: "bad", label: "Error" };
  if (!m.start) return { tone: "ok", label: "Built" };
  if (s.every((x) => x === "active")) return { tone: "ok", label: "Ready" };
  if (s.some((x) => x === "active")) return { tone: "busy", label: "Partly up" };
  return { tone: "off", label: "Stopped" };
}


/* ---------- nodes and edges ---------- */

function RepoView({ data }: NodeProps<RepoNode>) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line-strong bg-panel/95 px-3 shadow-lg shadow-black/30 backdrop-blur" style={{ width: SIZE.repo.w, height: SIZE.repo.h }}>
      <GithubMark className="size-4 text-white" />
      <div className="min-w-0">
        <p className="truncate text-[12.5px] font-medium text-white">{data.repo}</p>
        <p className="flex items-center gap-1 text-[10.5px] text-muted">
          <GitBranch className="size-3" /> {data.branch} · {data.auto ? "deploys on push" : "manual deploys"}
        </p>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} className="!size-2 !border-0 !bg-accent/70" />
    </div>
  );
}

function ProjView({ data }: NodeProps<ProjNode>) {
  const Icon = ICON[data.type];
  return (
    <div
      className={cx(
        "rounded-2xl border bg-panel/95 p-3 shadow-xl shadow-black/40 backdrop-blur transition-colors",
        data.selected ? "border-accent ring-2 ring-accent/30" : "border-line-strong hover:border-white/25",
      )}
      style={{ width: SIZE.proj.w, height: SIZE.proj.h }}
    >
      <Handle type="target" position={Position.Left} className="!size-2.5 !border-2 !border-panel !bg-accent/80" />
      <div className="flex items-start gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line-strong bg-chip text-ink">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-white">{data.name}</p>
          <p className="flex items-center gap-1 truncate text-[11px] text-muted">
            {data.locked && <Lock className="size-3 shrink-0" />}
            <span className="truncate">{data.sub}</span>
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-ink">
          <span className={cx("size-1.5 rounded-full", DOT[data.tone])} />
          {data.label}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-1">
        <span className="text-[10.5px] text-muted">{data.framework ?? TYPE_LABEL[data.type].one}</span>
        <span className="flex-1" />
        {data.machines.slice(0, 4).map((m) => (
          <span key={m} className="rounded bg-chip px-1 font-mono text-[10px] text-ink">
            {m}
          </span>
        ))}
        {data.machines.length > 4 && <span className="text-[10px] text-muted">+{data.machines.length - 4}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!size-2.5 !border-2 !border-panel !bg-accent" title="Drag to a database or service to connect" />
    </div>
  );
}

function RelView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<RelEdge>) {
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 18, offset: 26 });
  const uses = data?.tone === "uses";
  const stroke = selected ? "var(--accent-soft)" : uses ? "var(--accent)" : data?.tone === "deploy" ? "hsl(var(--h) 95% 73% / 0.55)" : "var(--line-strong)";
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={22} style={{ stroke, strokeWidth: selected ? 2.5 : uses ? 2 : 1.5, strokeDasharray: data?.tone === "manual" ? "6 6" : undefined }} />
      {(data?.busy || uses) && (
        <circle r={data?.busy ? 3.5 : 2.4} fill="var(--accent-soft)">
          <animateMotion dur={data?.busy ? "1.2s" : "2.8s"} repeatCount="indefinite" path={path} />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            className={cx("nodrag nopan pointer-events-none absolute rounded-md px-1.5 py-0.5 font-mono text-[10px] ring-1", selected ? "bg-accent text-[#0b0e1c] ring-accent" : "bg-panel text-ink ring-accent/40")}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { repo: RepoView, proj: ProjView };
const edgeTypes = { rel: RelView };

/**
 * Auto-arranged every time the graph changes. Connected things flow left to right in columns: repos, then each
 * app one column after whatever feeds it, each database one column after the apps using it, so every line spans
 * a single gap and never runs behind a card. Each card sits level with what it connects to. Everything not
 * connected to anything sits in a tidy grid underneath, apps first, then databases.
 */
function layout(nodes: AnyNode[], edges: RelEdge[]): AnyNode[] {
  const GAP_Y = 36;
  const GAP_X = 130;
  const GRID_GAP = 40;
  const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
  const flow = nodes.filter((n) => linked.has(n.id));
  const byId = new Map(flow.map((n) => [n.id, n]));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    preds.set(e.target, [...(preds.get(e.target) ?? []), e.source]);
    succs.set(e.source, [...(succs.get(e.source) ?? []), e.target]);
  }
  const h = (id: string) => SIZE[byId.get(id)!.type].h;
  const name = (id: string) => id.replace(/^\w+:/, "");

  // column = longest path from the left (repos are 0, projects start at 1); bounded so a cycle can't loop forever
  const col = new Map(flow.map((n) => [n.id, n.type === "repo" ? 0 : 1]));
  for (let round = 0; round < flow.length; round++) {
    let moved = false;
    for (const [t, ps] of preds) {
      const want = Math.max(...ps.map((p) => col.get(p)! + 1));
      if (want > col.get(t)!) {
        col.set(t, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const columns: string[][] = [];
  for (const n of flow) (columns[col.get(n.id)!] ??= []).push(n.id);

  const y = new Map<string, number>();
  const center = (id: string) => y.get(id)! + h(id) / 2;
  const stack = (ids: string[], want: (id: string) => number) => {
    const order = [...ids].sort((a, b) => want(a) - want(b) || name(a).localeCompare(name(b)));
    let next = -Infinity;
    for (const id of order) {
      const w = want(id);
      const top = Math.max(Number.isFinite(w) ? w - h(id) / 2 : next, next === -Infinity ? 0 : next);
      y.set(id, Number.isFinite(top) ? top : 0);
      next = y.get(id)! + h(id) + GAP_Y;
    }
  };
  const mean = (ids: string[] | undefined) => (ids?.length ? ids.reduce((s, id) => s + (y.has(id) ? center(id) : 0), 0) / ids.length : Infinity);
  // left to right: line up with what feeds you; then right to left: things nothing feeds line up with what they feed
  for (const c of columns) if (c) stack(c, (id) => mean(preds.get(id)?.filter((p) => y.has(p))));
  for (let i = columns.length - 1; i >= 0; i--) {
    const c = columns[i];
    if (c) stack(c, (id) => (preds.get(id)?.length ? center(id) : mean(succs.get(id)?.filter((s) => y.has(s)))));
  }

  const pos = new Map<string, { x: number; y: number }>();
  let x = 0;
  let bottom = 0;
  const minY = Math.min(0, ...[...y.values()]);
  for (const c of columns) {
    if (!c) continue;
    const w = Math.max(...c.map((id) => SIZE[byId.get(id)!.type].w));
    for (const id of c) {
      pos.set(id, { x: x + (w - SIZE[byId.get(id)!.type].w), y: y.get(id)! - minY });
      bottom = Math.max(bottom, y.get(id)! - minY + h(id));
    }
    x += w + GAP_X;
  }
  const width = Math.max(0, x - GAP_X);

  const rest = nodes
    .filter((n): n is ProjNode => !linked.has(n.id) && n.type === "proj")
    .sort((a, b) => Number(a.data.type === "database") - Number(b.data.type === "database") || a.data.name.localeCompare(b.data.name));
  const { w, h: rh } = SIZE.proj;
  const cols = Math.max(3, Math.min(5, Math.floor((width + GRID_GAP) / (w + GRID_GAP)) || 4));
  const top = flow.length ? bottom + 110 : 0;
  rest.forEach((n, i) => pos.set(n.id, { x: (i % cols) * (w + GRID_GAP), y: top + Math.floor(i / cols) * (rh + GRID_GAP) }));

  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? { x: 0, y: 0 } }) as AnyNode);
}

/* ---------- the canvas ---------- */

let pipelineSid: string | null = null; // the AI panel's session survives page changes

export function ProjectCanvas() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}

type Sel = { kind: "proj"; name: string } | { kind: "uses"; from: string; to: string } | { kind: "repo"; repo: string } | null;

function Inner() {
  const { vms, status, refresh, openJob } = useCluster();
  const { fitView } = useReactFlow();
  const [sel, setSel] = useState<Sel>(null);
  const [pending, setPending] = useState<{ from: string; to: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const projects = useMemo(() => {
    const map = new Map<string, Proj>();
    for (const v of vms) {
      const a = status[v.name]?.agent;
      for (const p of a?.projects ?? []) {
        const name = p.manifest.name;
        const deploying = (a?.jobs ?? []).some((j) => j.state === "running" && j.meta.kind === "deploy" && j.meta.project === name);
        const e = map.get(name) ?? { name, m: p.manifest, type: projectType(p.manifest), inst: [], url: null, tone: "ok" as Tone, label: "" };
        e.inst.push({ vm: v.name, p, deploying });
        if (p.url && !e.url) e.url = p.url;
        if ((p.manifest.uses?.length ?? 0) > (e.m.uses?.length ?? 0)) e.m = p.manifest;
        map.set(name, e);
      }
    }
    for (const e of map.values()) Object.assign(e, health(e.inst, e.m));
    return map;
  }, [vms, status]);

  const graph = useMemo(() => {
    const ns: AnyNode[] = [];
    const es: RelEdge[] = [];
    const repos = new Map<string, RepoData>();
    for (const p of projects.values()) {
      const sub =
        p.url ? shortLabel(p.name) : p.type === "database" ? `127.0.0.1:${p.m.port ?? "?"} · private` : p.m.port ? `port ${p.m.port} · no link` : "background process";
      ns.push({
        id: `p:${p.name}`,
        type: "proj",
        position: { x: 0, y: 0 },
        data: { name: p.name, type: p.type, tone: p.tone, label: p.label, sub, locked: !p.url || p.url.includes("_token="), machines: p.inst.map((i) => i.vm), framework: p.m.framework, selected: sel?.kind === "proj" && sel.name === p.name },
      });
      if (p.m.github) {
        const r = repos.get(p.m.github.repo) ?? { repo: p.m.github.repo, branch: p.m.branch, auto: false, projects: [] };
        r.auto ||= p.m.github.autoDeploy;
        r.projects.push(p.name);
        repos.set(p.m.github.repo, r);
        es.push({
          id: `d:${p.m.github.repo}:${p.name}`,
          source: `repo:${p.m.github.repo}`,
          target: `p:${p.name}`,
          type: "rel",
          data: { label: p.m.github.autoDeploy ? "push → deploy" : "manual", tone: p.m.github.autoDeploy ? "deploy" : "manual", busy: p.inst.some((i) => i.deploying) },
        });
      }
      for (const u of p.m.uses ?? [])
        if (projects.has(u.name))
          es.push({
            id: `u:${p.name}:${u.name}`,
            source: `p:${p.name}`,
            target: `p:${u.name}`,
            type: "rel",
            selected: sel?.kind === "uses" && sel.from === p.name && sel.to === u.name,
            data: { label: u.env, tone: "uses", busy: false },
          });
    }
    for (const r of repos.values()) ns.push({ id: `repo:${r.repo}`, type: "repo", position: { x: 0, y: 0 }, data: r });
    return { nodes: layout(ns, es), edges: es, shape: ns.map((n) => n.id).join("|") + es.map((e) => e.id).join("|") };
  }, [projects, sel]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AnyNode>([]);
  const [edges, setEdges] = useEdgesState<RelEdge>([]);
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((n) => {
        const old = byId.get(n.id);
        return (old ? { ...old, position: n.position, data: n.data } : n) as AnyNode;
      });
    });
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: { top: "90px", bottom: "140px", left: "40px", right: sel ? "420px" : "40px" }, duration: 400 }), 80);
    return () => clearTimeout(t);
    // refit when the shape changes, not on every status tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.shape, fitView]);

  const connect = async () => {
    if (!pending) return;
    setConnecting(true);
    try {
      const r = await api<{ output: string }>("/api/connections", pending);
      setFlash({ ok: true, text: r.output });
      setSel({ kind: "uses", ...pending });
      await refresh();
    } catch (e) {
      setFlash({ ok: false, text: (e as Error).message });
    } finally {
      setConnecting(false);
      setPending(null);
    }
  };

  const empty = projects.size === 0;

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        minZoom={0.25}
        maxZoom={1.6}
        isValidConnection={(c) => Boolean(c.source?.startsWith("p:") && c.target?.startsWith("p:") && c.source !== c.target)}
        onConnect={(c: Connection) => c.source && c.target && setPending({ from: c.source.slice(2), to: c.target.slice(2) })}
        onNodeClick={(_, n) => setSel(n.id.startsWith("p:") ? { kind: "proj", name: n.id.slice(2) } : { kind: "repo", repo: n.id.slice(5) })}
        onEdgeClick={(_, e) => {
          if (e.id.startsWith("u:")) {
            const [, from, to] = e.id.split(":");
            setSel({ kind: "uses", from, to });
          } else setSel({ kind: "proj", name: e.target.slice(2) });
        }}
        onPaneClick={() => setSel(null)}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{ stroke: "var(--accent)", strokeWidth: 2 }}
        style={{ background: "transparent" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--line)" />
        <Controls showInteractive={false} position="bottom-left" style={{ marginBottom: 96 }} />
      </ReactFlow>

      {empty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="rounded-xl bg-black/50 px-4 py-3 text-sm text-ink backdrop-blur">No projects yet. Deploy one from Projects, or ask the AI below.</p>
        </div>
      )}

      <p className="pointer-events-none absolute top-16 left-4 rounded-lg bg-black/45 px-3 py-1.5 text-[11.5px] text-ink backdrop-blur">
        Drag from a project&apos;s right dot to a database or service to connect them · click anything for details
      </p>

      {flash && (
        <div className={cx("absolute top-16 left-1/2 z-20 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur", flash.ok ? "border-accent/40 bg-panel/95 text-ink" : "border-[var(--critical)]/50 bg-panel/95 text-[var(--critical-text)]")}>
          <span>{flash.text}</span>
          <button onClick={() => setFlash(null)} className="text-muted hover:text-white" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      )}

      {pending && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/40 backdrop-blur-[1px]">
          <div className="w-[440px] rounded-2xl border border-line-strong bg-panel p-5 shadow-2xl">
            <p className="flex items-center gap-2 text-base font-semibold text-white">
              <Plug className="size-4 text-accent-soft" /> Connect {pending.from} <ArrowRight className="size-4 text-muted" /> {pending.to}?
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-ink">
              <li>
                • Sets{" "}
                <code className="text-white">
                  {projects.get(pending.to)?.type === "database"
                    ? /mongo/.test(projects.get(pending.to)?.m.start ?? "")
                      ? "MONGODB_URI"
                      : /redis/.test(projects.get(pending.to)?.m.start ?? "")
                        ? "REDIS_URL"
                        : "DATABASE_URL"
                    : `${pending.to.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL`}
                </code>{" "}
                on {pending.from}, built from {pending.to}&apos;s stored credentials
              </li>
              {projects.get(pending.to)?.type === "database" && /mysql|postgres/.test(projects.get(pending.to)?.m.start ?? "") && (
                <li>
                  • Also sets <code className="text-white">DB_HOST</code>, <code className="text-white">DB_PORT</code>, <code className="text-white">DB_DATABASE</code>,{" "}
                  <code className="text-white">DB_USERNAME</code>, <code className="text-white">DB_PASSWORD</code> for PHP/Laravel and others
                </li>
              )}
              <li>• Opens a private tunnel if they run on different machines</li>
              <li>• Restarts {pending.from} so it picks the setting up</li>
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={connect} loading={connecting}>
                Connect
              </Button>
            </div>
          </div>
        </div>
      )}

      {sel && <Inspector sel={sel} projects={projects} status={status} onClose={() => setSel(null)} onSelect={setSel} onFlash={setFlash} openJob={openJob} refresh={refresh} />}

      <AiBar sel={sel} />
    </div>
  );
}

/* ---------- details panel ---------- */

function Inspector({
  sel,
  projects,
  status,
  onClose,
  onSelect,
  onFlash,
  openJob,
  refresh,
}: {
  sel: NonNullable<Sel>;
  projects: Map<string, Proj>;
  status: Record<string, VmStatus | undefined>;
  onClose: () => void;
  onSelect: (s: Sel) => void;
  onFlash: (f: { ok: boolean; text: string } | null) => void;
  openJob: (j: { vm: string; id: string; title: string }) => void;
  refresh: (names?: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ name: string; vm: string; text: string } | null>(null);
  const [target, setTarget] = useState("");

  const actAll = async (p: Proj, action: "deploy" | "restart" | "stop" | "start" | "remove") => {
    if (action === "remove" && !confirm(`Remove ${p.name} from ${p.inst.map((i) => i.vm).join(", ")}? Its service, code and link are deleted.`)) return;
    setBusy(action);
    try {
      const rs = await Promise.all(p.inst.map((i) => api<{ jobId?: string }>("/api/projects/action", { vm: i.vm, name: p.name, action }).then((r) => ({ vm: i.vm, ...r }))));
      const first = rs.find((r) => r.jobId);
      if (first?.jobId) openJob({ vm: first.vm, id: first.jobId, title: `deploy ${p.name}` });
      onFlash({ ok: true, text: action === "remove" ? `Removed ${p.name}.` : `${action === "deploy" ? "Redeploying" : action === "restart" ? "Restarted" : action === "stop" ? "Stopped" : "Started"} ${p.name} on ${p.inst.map((i) => i.vm).join(", ")}.` });
      if (action === "remove") onClose();
      await refresh(p.inst.map((i) => i.vm));
    } catch (e) {
      onFlash({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (from: string, to: string) => {
    if (!confirm(`Disconnect ${from} from ${to}? Its env var is removed and ${from} restarts.`)) return;
    setBusy("disconnect");
    try {
      const r = await api<{ output: string }>("/api/connections", { from, to, disconnect: true });
      onFlash({ ok: true, text: r.output });
      onSelect({ kind: "proj", name: from });
      await refresh();
    } catch (e) {
      onFlash({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const connectTo = async (from: string, to: string) => {
    setBusy("connect");
    try {
      const r = await api<{ output: string }>("/api/connections", { from, to });
      onFlash({ ok: true, text: r.output });
      onSelect({ kind: "uses", from, to });
      await refresh();
    } catch (e) {
      onFlash({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      setTarget("");
    }
  };

  const showLogs = async (name: string, vm: string) => {
    setLogs({ name, vm, text: "Loading…" });
    try {
      const r = await api<{ output: string }>("/api/projects/action", { vm, name, action: "logs" });
      setLogs({ name, vm, text: r.output || "(no output yet)" });
    } catch (e) {
      setLogs({ name, vm, text: (e as Error).message });
    }
  };

  let body: React.ReactNode = null;
  if (sel.kind === "proj") {
    const p = projects.get(sel.name);
    if (!p) body = <p className="text-sm text-muted">This project is gone.</p>;
    else {
      const Icon = ICON[p.type];
      const usedBy = [...projects.values()].filter((x) => x.m.uses?.some((u) => u.name === p.name));
      const candidates = [...projects.values()].filter((x) => x.name !== p.name && !p.m.uses?.some((u) => u.name === x.name) && (x.type === "database" || x.type === "service" || x.type === "website"));
      const commit = p.inst.find((i) => i.p.commit)?.p.commit;
      const running = p.inst.some((i) => i.p.active === "active");
      body = (
        <>
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-line-strong bg-chip text-ink">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-semibold text-white">{p.name}</p>
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <span className={cx("size-1.5 rounded-full", DOT[p.tone])} /> {p.label} · {TYPE_LABEL[p.type].one}
                {p.m.framework ? ` · ${p.m.framework}` : ""}
              </p>
            </div>
          </div>

          {p.url && (
            <div className="mt-4 flex items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1.5">
              {p.url.includes("_token=") && <Lock className="size-3.5 shrink-0 text-muted" />}
              <a href={shortLink(p.name)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-accent-soft hover:underline">
                {shortLabel(p.name)}
              </a>
              <a href={shortLink(p.name)} target="_blank" rel="noreferrer" className="rounded-md p-1 text-muted hover:text-white" title="Open">
                <ExternalLink className="size-3.5" />
              </a>
              <CopyButton text={shortLink(p.name)} label="Copy" />
            </div>
          )}

          <div className="mt-4 grid grid-cols-3 gap-1.5">
            <Button size="sm" onClick={() => void actAll(p, "deploy")} loading={busy === "deploy"}>
              <RefreshCw className="size-3.5" /> Redeploy
            </Button>
            <Button size="sm" onClick={() => void actAll(p, "restart")} loading={busy === "restart"}>
              <RotateCw className="size-3.5" /> Restart
            </Button>
            {running ? (
              <Button size="sm" onClick={() => void actAll(p, "stop")} loading={busy === "stop"}>
                <Square className="size-3.5" /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => void actAll(p, "start")} loading={busy === "start"}>
                <Play className="size-3.5" /> Start
              </Button>
            )}
            <Button size="sm" onClick={() => void showLogs(p.name, p.inst[0].vm)}>
              <ScrollText className="size-3.5" /> Logs
            </Button>
            <Link href={`/projects/${p.name}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-xs text-ink hover:border-white/20">
              <Settings2 className="size-3.5" /> Settings
            </Link>
            <Button size="sm" variant="danger" onClick={() => void actAll(p, "remove")} loading={busy === "remove"}>
              <Trash2 className="size-3.5" /> Remove
            </Button>
          </div>

          <Block title="Source">
            {p.m.github ? (
              <a href={`https://github.com/${p.m.github.repo}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-white hover:underline">
                <GithubMark /> {p.m.github.repo}
              </a>
            ) : (
              <p className="truncate text-sm text-ink">{p.m.repo || (/docker/.test(p.m.start) ? "Docker image" : "files on the machine")}</p>
            )}
            {p.m.repo && (
              <p className="mt-1 text-xs text-muted">
                <GitBranch className="mr-1 inline size-3" />
                {p.m.branch}
                {p.m.github ? (p.m.github.autoDeploy ? " · redeploys on every push" : " · manual deploys") : ""}
              </p>
            )}
            {commit && (
              <p className="mt-1.5 truncate text-xs text-ink" title={commit.message}>
                <span className="font-mono text-muted">{commit.sha.slice(0, 7)}</span> {commit.message}
              </p>
            )}
          </Block>

          <Block title="Runs on">
            {p.inst.map((i) => (
              <div key={i.vm} className="flex items-center gap-2 py-1 text-sm">
                <span className="w-12 font-mono text-white">{i.vm}</span>
                <span className="text-xs text-muted">{i.deploying ? "building…" : i.p.active}</span>
                <span className="flex-1" />
                <span className="text-xs text-muted">{timeAgo(i.p.deployedAt ? i.p.deployedAt * 1000 : null)}</span>
                <button onClick={() => void showLogs(p.name, i.vm)} className="rounded p-1 text-muted hover:text-white" title={`Logs on ${i.vm}`}>
                  <ScrollText className="size-3.5" />
                </button>
              </div>
            ))}
          </Block>

          <Block title="Connections">
            {(p.m.uses ?? []).map((u) => (
              <div key={u.name} className="flex items-center gap-2 py-1 text-sm">
                <button onClick={() => onSelect({ kind: "uses", from: p.name, to: u.name })} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-ink hover:text-white">
                  uses <b className="text-white">{u.name}</b> <span className="truncate font-mono text-[11px] text-muted">via {u.env}</span>
                </button>
                <button onClick={() => void disconnect(p.name, u.name)} className="rounded p-1 text-muted hover:text-[var(--critical-text)]" title="Disconnect">
                  <Unplug className="size-3.5" />
                </button>
              </div>
            ))}
            {usedBy.map((x) => (
              <button key={x.name} onClick={() => onSelect({ kind: "uses", from: x.name, to: p.name })} className="block py-1 text-left text-sm text-ink hover:text-white">
                used by <b className="text-white">{x.name}</b>
              </button>
            ))}
            {!p.m.uses?.length && !usedBy.length && <p className="text-xs text-muted">Not connected to anything. Drag from its right dot, or pick below.</p>}
            {p.type !== "database" && candidates.length > 0 && (
              <div className="mt-2 flex gap-1.5">
                <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-2 text-xs text-ink">
                  <option value="">Connect to…</option>
                  {candidates.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} ({TYPE_LABEL[c.type].one.toLowerCase()})
                    </option>
                  ))}
                </select>
                <Button size="sm" disabled={!target} loading={busy === "connect"} onClick={() => void connectTo(p.name, target)}>
                  <Plug className="size-3.5" /> Connect
                </Button>
              </div>
            )}
          </Block>
        </>
      );
    }
  } else if (sel.kind === "uses") {
    const from = projects.get(sel.from);
    const to = projects.get(sel.to);
    const link = from?.m.uses?.find((u) => u.name === sel.to);
    if (!from || !to || !link) body = <p className="text-sm text-muted">This connection is gone.</p>;
    else {
      const toVm = to.inst[0]?.vm;
      body = (
        <>
          <p className="flex items-center gap-2 text-lg font-semibold text-white">
            {from.name} <ArrowRight className="size-4 text-muted" /> {to.name}
          </p>
          <p className="mt-1 text-sm text-muted">
            {from.name} reaches {to.name} through <code className="text-white">{link.env}</code>.
          </p>
          <Block title="How each machine connects">
            {from.inst.map((i) => {
              const same = i.vm === toVm;
              const t = status[i.vm]?.agent?.tunnels.find((x) => x.to === toVm);
              return (
                <div key={i.vm} className="flex items-center gap-2 py-1 text-sm">
                  <span className="w-12 font-mono text-white">{i.vm}</span>
                  <span className="text-xs text-ink">{same ? `same machine · 127.0.0.1:${to.m.port ?? ""}` : to.type === "database" ? `tunnel to ${toVm}` : `over ${to.name}'s link`}</span>
                  <span className="flex-1" />
                  {!same && to.type === "database" && (
                    <span className={cx("text-xs", t?.active === "active" ? "text-accent-soft" : "text-[var(--critical-text)]")}>{t?.active ?? "no tunnel"}</span>
                  )}
                </div>
              );
            })}
          </Block>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => onSelect({ kind: "proj", name: from.name })}>
              Open {from.name}
            </Button>
            <Button size="sm" onClick={() => onSelect({ kind: "proj", name: to.name })}>
              Open {to.name}
            </Button>
            <Button size="sm" variant="danger" loading={busy === "disconnect"} onClick={() => void disconnect(from.name, to.name)}>
              <Unplug className="size-3.5" /> Disconnect
            </Button>
          </div>
        </>
      );
    }
  } else {
    const ps = [...projects.values()].filter((p) => p.m.github?.repo === sel.repo);
    body = (
      <>
        <a href={`https://github.com/${sel.repo}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-lg font-semibold text-white hover:underline">
          <GithubMark className="size-5" /> {sel.repo}
        </a>
        <Block title="Deploys to">
          {ps.map((p) => (
            <button key={p.name} onClick={() => onSelect({ kind: "proj", name: p.name })} className="flex w-full items-center gap-2 py-1 text-left text-sm text-ink hover:text-white">
              <b className="text-white">{p.name}</b> <span className="text-xs text-muted">{p.m.branch} · {p.m.github?.autoDeploy ? "on every push" : "manually"}</span>
            </button>
          ))}
        </Block>
      </>
    );
  }

  return (
    <>
      <aside className="scroll-thin absolute top-3 right-3 bottom-24 z-10 w-[380px] overflow-y-auto rounded-2xl border border-line-strong bg-panel/95 p-5 shadow-2xl backdrop-blur">
        <button onClick={onClose} className="absolute top-3 right-3 rounded-md p-1 text-muted hover:bg-white/5 hover:text-white" aria-label="Close">
          <X className="size-4" />
        </button>
        {body}
      </aside>
      {logs && (
        <Drawer title={`${logs.name} logs`} subtitle={<span className="font-mono">{logs.vm}</span>} onClose={() => setLogs(null)}>
          <Output text={logs.text} className="max-h-none" />
        </Drawer>
      )}
    </>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</p>
      {children}
    </section>
  );
}

/* ---------- AI bar ---------- */

function AiBar({ sel }: { sel: Sel }) {
  const { vms, status, refresh } = useCluster();
  const router = useRouter();
  const st = useAssistant();
  const [sid, setSid] = useState<string | null>(() => pipelineSid);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(true);
  const [art, setArt] = useState<string | null>(null);
  const doc = sid ? (st.docs[sid] ?? getDoc(sid)) : null;
  const busy = Boolean(doc?.busy || doc?.remote);
  const mentions = useMemo(() => new Set(entitiesFrom(vms, status).map((e) => e.name)), [vms, status]);

  // refresh the canvas when a run finishes
  const [was, setWas] = useState(busy);
  if (was !== busy) {
    setWas(busy);
    if (!busy) void refresh();
  }

  const selected = sel?.kind === "proj" ? sel.name : sel?.kind === "uses" ? `${sel.from}` : null;
  const ask = () => {
    const t = text.trim();
    if (!t || busy) return;
    const id = sid ?? newId();
    if (!sid) {
      ensureDoc(id, `Pipeline · ${t.slice(0, 60)}`);
      setSid(id);
      pipelineSid = id;
    }
    const focus = selected && !t.includes(`@${selected}`) ? `\n\n(The user has @${selected} selected on the Pipeline.)` : "";
    updateItems(id, (x) => [...x, { kind: "user", text: t }]);
    void send(id, { message: t + focus + contextFor(`${t} ${selected ? `@${selected}` : ""}`, vms, status), display: t, source: "pipeline" });
    setText("");
    setOpen(true);
  };

  const items = doc?.items ?? [];
  const artVersions = items.filter((i): i is Extract<(typeof items)[number], { kind: "artifact" }> => i.kind === "artifact" && i.id === art);
  return (
    <div className="absolute inset-x-3 bottom-3 z-20 mx-auto max-w-3xl">
      {art && artVersions.length > 0 && (
        <Drawer title={artVersions[artVersions.length - 1].title} onClose={() => setArt(null)}>
          <div className="-m-5 h-[calc(100dvh-90px)]">
            <ArtifactView versions={artVersions} onClose={() => setArt(null)} />
          </div>
        </Drawer>
      )}
      {doc && items.length > 0 && open && (
        <div className="mb-2 overflow-hidden rounded-2xl border border-line-strong bg-panel/95 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2">
            <Sparkles className="size-3.5 text-accent-soft" />
            <span className="truncate text-xs font-medium text-white">{doc.title}</span>
            {busy && <Loader2 className="size-3.5 animate-spin text-accent" />}
            <span className="flex-1" />
            <button
              onClick={() => {
                void openSession(sid!);
                router.push("/assistant");
              }}
              className="text-xs text-accent-soft hover:text-white"
            >
              Open in Assistant
            </button>
            <button
              onClick={() => {
                setSid(null);
                pipelineSid = null;
              }}
              className="text-xs text-muted hover:text-white"
              disabled={busy}
            >
              New
            </button>
            <button onClick={() => setOpen(false)} className="rounded p-0.5 text-muted hover:text-white" aria-label="Minimise">
              <Minimize2 className="size-3.5" />
            </button>
          </div>
          <div className="scroll-thin max-h-[42vh] overflow-y-auto px-4 py-3 text-[13.5px]">
            <ChatItems sid={sid!} items={items.slice(-14)} busy={busy} mentions={mentions} compact onOpenArtifact={setArt} />
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 rounded-2xl border border-line-strong bg-panel/95 p-2 shadow-2xl backdrop-blur">
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[11px] text-ink">
          <Sparkles className="size-3 text-accent-soft" /> {selected ? `@${selected}` : "AI"}
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder={selected ? `Tell the AI what to do with ${selected}… (remove it, connect it to postgres, show errors)` : "Tell the AI… remove sam-portfolio · connect watch to postgres · run df -h on box2"}
          className="min-w-0 flex-1 bg-transparent px-1 text-sm text-white placeholder:text-muted focus:outline-none"
        />
        {doc && items.length > 0 && !open && (
          <button onClick={() => setOpen(true)} className="rounded-md p-1.5 text-muted hover:text-white" title="Show the AI's work">
            <Maximize2 className="size-4" />
          </button>
        )}
        {busy ? (
          <Button size="sm" variant="danger" onClick={() => sid && void stop(sid)}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={ask} disabled={!text.trim()}>
            <SendHorizonal className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
