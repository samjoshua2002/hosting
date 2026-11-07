"use client";

import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
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
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ExternalLink, Loader2, Play, Radio, ScrollText } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fmtDuration, fmtKb, vmMetrics, vmState, type VmState } from "@/lib/format";
import { isDestructive } from "@/lib/safety";
import type { ExecResult } from "@/lib/types";
import { useCluster } from "./cluster";
import { Badge, Button, Meter, Output, StatusDot, cx, serviceTone } from "./ui";

/* ---------- node & edge types ---------- */

type ControlData = { online: number; total: number; busy: number; projects: number };
type VmData = {
  name: string;
  state: VmState;
  host: string;
  cpu: number | null;
  mem: number | null;
  projects: number;
  command?: string;
  result?: ExecResult;
  selected: boolean;
  error?: string;
};
type ProjectData = { name: string; active: string; url: string | null; port: number | null };
type FlowData = { tone: "ok" | "off" | "busy" | "dim"; label?: string };

type AnyNode = Node<ControlData, "control"> | Node<VmData, "vm"> | Node<ProjectData, "project">;
type FlowEdge = Edge<FlowData, "flow">;

const SIZE = { control: { w: 240, h: 150 }, vm: { w: 230, h: 128 }, project: { w: 190, h: 36 } } as const;
const hiddenHandle = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

function In() {
  return <Handle type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />;
}
function Out() {
  return <Handle type="source" position={Position.Right} style={hiddenHandle} isConnectable={false} />;
}

function ControlNodeView({ data }: NodeProps<Node<ControlData, "control">>) {
  return (
    <div className="rounded-2xl border border-accent/50 bg-panel-2 p-4 shadow-[0_0_44px_-10px_var(--glow)]" style={{ width: SIZE.control.w }}>
      <Out />
      <div className="flex items-center gap-2">
        <Radio className="size-4 text-accent-soft" />
        <span className="text-sm font-semibold text-white">Control plane</span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted">Dispatches commands and deploys over SSH</p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Mini label="online" value={`${data.online}/${data.total}`} />
        <Mini label="running" value={String(data.busy)} />
        <Mini label="projects" value={String(data.projects)} />
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-black/25 py-1.5">
      <div className="text-sm font-semibold text-white tabular-nums">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

function VmNodeView({ data }: NodeProps<Node<VmData, "vm">>) {
  const r = data.result;
  return (
    <div
      className={cx(
        "rounded-2xl border bg-panel p-3 transition-shadow",
        data.command ? "border-accent shadow-[0_0_28px_-8px_var(--glow)]" : "border-line-strong",
        data.selected && "ring-2 ring-accent ring-offset-2 ring-offset-[var(--bg)]",
        data.state === "offline" && "opacity-70",
      )}
      style={{ width: SIZE.vm.w }}
    >
      <In />
      <Out />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusDot state={data.state} />
          <span className="truncate font-mono text-sm font-semibold text-white">{data.name}</span>
        </div>
        {r && !data.command && <Badge tone={r.code === 0 ? "green" : "red"}>{r.code === 0 ? "ok" : r.code === null ? "error" : `exit ${r.code}`}</Badge>}
      </div>
      <p className="mt-0.5 truncate text-[10px] text-muted">{data.host}</p>
      {data.command ? (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md bg-accent/10 px-2 py-1.5 text-[10px] text-ink">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="truncate font-mono">{data.command}</span>
        </div>
      ) : data.cpu !== null ? (
        <div className="mt-2.5 space-y-1.5">
          <Bar label="cpu" v={data.cpu} />
          <Bar label="mem" v={data.mem ?? 0} />
        </div>
      ) : (
        <p className={cx("mt-2 line-clamp-2 text-[10px]", data.state === "offline" ? "text-[var(--critical-text)]" : "text-muted")}>
          {data.state === "checking" ? "waking up…" : (data.error ?? "not checked yet")}
        </p>
      )}
    </div>
  );
}

function Bar({ label, v }: { label: string; v: number }) {
  const color = v >= 90 ? "bg-[var(--critical)]" : v >= 70 ? "bg-[var(--warning)]" : "bg-accent";
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-6 text-muted">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-track">
        <div className={cx("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${Math.min(100, v)}%` }} />
      </div>
      <span className="w-7 text-right tabular-nums text-ink/80">{v}%</span>
    </div>
  );
}

function ProjectNodeView({ data }: NodeProps<Node<ProjectData, "project">>) {
  const failed = data.active === "failed";
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-line-strong bg-panel-2 px-3 py-1.5 text-[11px]"
      style={{ width: SIZE.project.w, height: SIZE.project.h }}
    >
      <In />
      <span className={cx("size-1.5 shrink-0 rounded-full", failed ? "bg-[var(--critical)]" : data.active === "active" ? "bg-accent" : "bg-[var(--others)]")} />
      <span className="truncate font-medium text-white">{data.name}</span>
      {data.port && <span className="text-muted">:{data.port}</span>}
      {data.url && <ExternalLink className="ml-auto size-3 shrink-0 text-accent-soft" />}
    </div>
  );
}

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 16, offset: 24 });
  const tone = data?.tone ?? "dim";
  const stroke = tone === "busy" ? "var(--accent)" : tone === "ok" ? "hsl(var(--h) 95% 73% / 0.5)" : tone === "off" ? "hsl(var(--h) 16% 40% / 0.8)" : "var(--line-strong)";
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke, strokeWidth: tone === "busy" ? 2 : 1.5, strokeDasharray: tone === "off" ? "6 6" : undefined }} />
      {tone === "busy" &&
        [0, 0.45, 0.9].map((d) => (
          <circle key={d} r={3.5} fill="var(--accent-soft)">
            <animateMotion dur="1.35s" begin={`${d}s`} repeatCount="indefinite" path={path} />
          </circle>
        ))}
      {tone === "ok" && (
        <circle r={2.2} fill="var(--accent-soft)" opacity={0.85}>
          <animateMotion dur="3.4s" repeatCount="indefinite" path={path} keyPoints="1;0" keyTimes="0;1" calcMode="linear" />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            className="nodrag nopan pointer-events-none absolute max-w-[170px] truncate rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-ink ring-1 ring-accent/40"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { control: ControlNodeView, vm: VmNodeView, project: ProjectNodeView };
const edgeTypes = { flow: FlowEdgeView };

/** Left-to-right pipeline (control → machines → projects) laid out by dagre: a tree, so edges never cross. */
function layoutPipeline(nodes: AnyNode[], edges: FlowEdge[]): AnyNode[] {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 110, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const s = SIZE[n.type as keyof typeof SIZE];
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of [...edges].reverse()) g.setEdge(e.source, e.target);
  dagreLayout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x, y: p.y } } as AnyNode;
  });
}

/* ---------- main ---------- */

export function ClusterCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

function CanvasInner() {
  const { vms, status, checking, inflight, results, exec, startJobs, openJob } = useCluster();
  const [selected, setSelected] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [background, setBackground] = useState(false);
  const [running, setRunning] = useState(false);
  const { fitView } = useReactFlow();
  const names = useMemo(() => vms.map((v) => v.name), [vms]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AnyNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);

  const graph = useMemo(() => {
    const online = names.filter((n) => status[n]?.ok).length;
    const allProjects = names.flatMap((n) => status[n]?.agent?.projects ?? []);
    const ns: AnyNode[] = [
      {
        id: "control",
        type: "control",
        position: { x: 0, y: 0 },
        data: { online, total: names.length, busy: names.filter((n) => inflight[n]).length, projects: allProjects.length },
      },
    ];
    const es: FlowEdge[] = [];
    for (const name of names) {
      const s = status[name];
      const st = vmState(s, Boolean(checking[name]));
      const m = vmMetrics(s);
      const fl = inflight[name];
      ns.push({
        id: `vm:${name}`,
        type: "vm",
        position: { x: 0, y: 0 },
        data: {
          name,
          state: st,
          host: s?.agent ? `${s.agent.hostname} · up ${fmtDuration(s.agent.uptimeSec)}` : (vms.find((v) => v.name === name)?.host ?? ""),
          cpu: m?.cpu ?? null,
          mem: m?.memPct ?? null,
          projects: s?.agent?.projects.length ?? 0,
          command: fl?.command,
          result: results[name],
          selected: selected.includes(name),
          error: s?.error,
        },
      });
      es.push({
        id: `e:${name}`,
        source: "control",
        target: `vm:${name}`,
        type: "flow",
        data: { tone: fl ? "busy" : st === "online" ? "ok" : st === "offline" ? "off" : "dim", label: fl ? fl.command.split("\n")[0].slice(0, 40) : undefined },
      });
      const a = s?.agent;
      for (const p of a?.projects ?? []) {
        const id = `p:${name}:${p.manifest.name}`;
        ns.push({
          id,
          type: "project",
          position: { x: 0, y: 0 },
          data: {
            name: p.manifest.name,
            active: p.active,
            port: p.manifest.port,
            url: p.url ?? a?.ports.find((x) => x.port === p.manifest.port)?.url ?? null,
          },
        });
        es.push({ id: `e:${id}`, source: `vm:${name}`, target: id, type: "flow", data: { tone: p.active === "active" ? "ok" : "dim" } });
      }
    }
    return { nodes: layoutPipeline(ns, es), edges: es, shape: ns.map((n) => n.id).join("|") };
  }, [names, status, checking, inflight, results, selected, vms]);
  const shape = graph.shape;

  // Push new data/positions into React Flow state, keeping the sizes it measured (handles and edges need them).
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

  // Re-fit only when the set of nodes changes (a VM or project added), not on every status tick.
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: { top: "70px", bottom: "110px", left: "40px", right: "40px" }, duration: 400 }), 80);
    return () => clearTimeout(t);
  }, [shape, fitView]);

  const onlineNames = names.filter((n) => status[n]?.ok);
  const targets = selected.length ? selected : onlineNames;

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || !targets.length) return;
    if (isDestructive(cmd) && !confirm(`This command can destroy data:\n\n${cmd}\n\nRun it on ${targets.join(", ")}?`)) return;
    setRunning(true);
    try {
      if (background) {
        const jobs = await startJobs(targets, cmd);
        const first = jobs.find((j) => j.id);
        if (first?.id) openJob({ vm: first.vm, id: first.id, title: cmd.slice(0, 80) });
      } else {
        await exec(targets, cmd);
      }
    } finally {
      setRunning(false);
    }
  };

  const focus = selected.length === 1 ? selected[0] : null;

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={[0.5, 0.5]}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.25}
        maxZoom={1.6}
        onNodeClick={(e, node) => {
          if (node.type === "control") return setSelected(onlineNames);
          const name = node.id.split(":")[1];
          setSelected((s) => (e.shiftKey || e.metaKey || e.ctrlKey ? (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]) : [name]));
        }}
        onPaneClick={() => setSelected([])}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--line)" />
        <Controls showInteractive={false} position="top-left" />
      </ReactFlow>

      <p className="pointer-events-none absolute top-3 left-14 rounded-md bg-black/40 px-2.5 py-1.5 text-[11px] text-muted backdrop-blur">
        Click a machine to inspect it · shift-click to pick several · commands go to the selection, or every online machine
      </p>

      {focus && <DetailPanel name={focus} onClose={() => setSelected([])} />}

      <div className="absolute inset-x-3 bottom-3 mx-auto max-w-3xl rounded-2xl border border-line-strong bg-panel/95 p-2 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full bg-chip px-2.5 py-1 font-mono text-[11px] text-ink">
            {selected.length ? `${selected.length} selected` : `all online (${onlineNames.length})`}
          </span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
            placeholder="Run a command, e.g. uptime"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-sm text-white placeholder:text-muted focus:outline-none"
          />
          <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted select-none" title="Keep running in the background">
            <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} className="accent-[var(--accent)]" />
            background
          </label>
          <Button variant="primary" size="sm" onClick={run} loading={running} disabled={!command.trim() || !targets.length}>
            <Play className="size-3" /> Run
          </Button>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ name, onClose }: { name: string; onClose: () => void }) {
  const { status, checking, results, refresh, openJob } = useCluster();
  const s = status[name];
  const a = s?.agent;
  const m = vmMetrics(s);
  const r = results[name];

  return (
    <div className="scroll-thin absolute top-14 right-3 bottom-24 w-[340px] overflow-auto rounded-2xl border border-line-strong bg-panel/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <StatusDot state={vmState(s, Boolean(checking[name]))} />
            <span className="font-mono font-semibold text-white">{name}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">{a ? `${a.hostname} · ${a.os}` : (s?.error ?? "not checked")}</p>
        </div>
        <button onClick={onClose} className="text-xs text-muted hover:text-white">
          close
        </button>
      </div>

      {m && a && (
        <div className="mt-4 space-y-2.5">
          <Meter label="CPU" value={m.cpu} detail={`${m.cpu}% · load ${a.load[0].toFixed(2)}`} />
          <Meter label="Memory" value={m.memPct} detail={`${fmtKb(m.memUsedKb)} / ${fmtKb(m.memTotalKb)}`} />
          <Meter label="Disk" value={m.diskPct} detail={`${fmtKb(m.diskUsedKb)} / ${fmtKb(m.diskTotalKb)}`} />
          <p className="text-[11px] text-muted">
            {a.cores} vCPU · up {fmtDuration(a.uptimeSec)} · {a.docker ? "Docker ready" : "no Docker"}
          </p>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={() => refresh([name])} loading={checking[name]}>
          Check now
        </Button>
        <Link href={`/run?vm=${name}`} className="inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-xs text-ink hover:bg-white/5">
          Open in Run
        </Link>
      </div>

      {a && a.projects.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-muted">Projects</h3>
          <ul className="space-y-1.5">
            {a.projects.map((p) => {
              const url = a.ports.find((x) => x.port === p.manifest.port)?.url;
              return (
                <li key={p.manifest.name} className="flex items-center justify-between gap-2 rounded-lg bg-black/25 px-2.5 py-1.5 text-xs">
                  <span className="truncate font-medium text-white">{p.manifest.name}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={serviceTone(p.active)}>{p.active}</Badge>
                    {url && (
                      <a href={url} target="_blank" rel="noreferrer" className="text-accent-soft">
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {a && a.jobs.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-muted">Recent jobs</h3>
          <ul className="space-y-1">
            {a.jobs.slice(0, 5).map((j) => (
              <li key={j.id}>
                <button
                  onClick={() => openJob({ vm: name, id: j.id, title: j.meta.label })}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-white/5"
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-ink/80">
                    <ScrollText className="size-3 shrink-0" />
                    {j.meta.label}
                  </span>
                  <Badge tone={j.state === "running" ? "blue" : j.exitCode === 0 ? "green" : j.state === "done" ? "red" : "gray"}>
                    {j.state === "done" ? `exit ${j.exitCode}` : j.state}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r && (
        <div className="mt-5">
          <h3 className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-muted">
            <span className="truncate font-mono">$ {r.command}</span>
            <Badge tone={r.code === 0 ? "green" : "red"}>{r.code === null ? "error" : `exit ${r.code}`}</Badge>
          </h3>
          {r.error && <p className="mb-2 text-xs text-[var(--critical-text)]">{r.error}</p>}
          <Output text={r.stdout} className="max-h-56" />
          <Output text={r.stderr} tone="err" className="mt-2 max-h-40" />
        </div>
      )}
    </div>
  );
}
