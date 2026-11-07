"use client";

import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import { Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Boxes, CalendarClock, CircleDot, Database, Globe, LayoutDashboard, Link2, Server, User, Webhook, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import type { DiagramEdge, DiagramNode } from "@/lib/assistant-items";
import { GithubMark } from "./github";

const W = 190;
const H = 54;

const ICONS: Record<string, LucideIcon> = {
  webhook: Webhook,
  dashboard: LayoutDashboard,
  machine: Server,
  service: Boxes,
  website: Globe,
  database: Database,
  cron: CalendarClock,
  link: Link2,
  user: User,
};

type D = Node<{ label: string; kind?: string; sub?: string }, "box">;

function BoxNode({ data, sourcePosition, targetPosition }: NodeProps<D>) {
  const Icon = data.kind ? ICONS[data.kind] : undefined;
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line-strong bg-panel px-3 shadow-lg shadow-black/30" style={{ width: W, height: H }}>
      <Handle type="target" position={targetPosition ?? Position.Left} className="!size-1.5 !border-0 !bg-accent/70" />
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-chip text-ink">
        {data.kind === "github" ? <GithubMark className="size-3.5" /> : Icon ? <Icon className="size-3.5" /> : <CircleDot className="size-3.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-medium text-white">{data.label}</span>
        {data.sub && <span className="block truncate text-[10.5px] text-muted">{data.sub}</span>}
      </span>
      <Handle type="source" position={sourcePosition ?? Position.Right} className="!size-1.5 !border-0 !bg-accent/70" />
    </div>
  );
}

const nodeTypes = { box: BoxNode };

/** A read-only left-to-right diagram the Assistant draws in chat. */
export function FlowDiagram({ title, nodes, edges }: { title: string; nodes: DiagramNode[]; edges: DiagramEdge[] }) {
  const { rfNodes, rfEdges, height, vertical } = useMemo(() => {
    const build = (rankdir: "LR" | "TB") => {
      const g = new graphlib.Graph();
      g.setGraph({ rankdir, nodesep: rankdir === "LR" ? 18 : 26, ranksep: rankdir === "LR" ? 70 : 44, marginx: 16, marginy: 16 });
      g.setDefaultEdgeLabel(() => ({}));
      for (const n of nodes) g.setNode(n.id, { width: W, height: H });
      for (const e of edges) g.setEdge(e.from, e.to);
      dagreLayout(g);
      return g;
    };
    // long chains don't fit the chat width left to right: stack them instead of shrinking the text
    let g = build("LR");
    const wide = ((g.graph() as { width?: number }).width ?? 0) > 720;
    if (wide) g = build("TB");
    const vertical = wide;
    const rfNodes: D[] = nodes.map((n) => {
      const p = g.node(n.id);
      return {
        id: n.id,
        type: "box",
        position: { x: p.x - W / 2, y: p.y - H / 2 },
        data: { label: n.label, kind: n.kind, sub: n.sub },
        sourcePosition: wide ? Position.Bottom : Position.Right,
        targetPosition: wide ? Position.Top : Position.Left,
      };
    });
    const rfEdges: Edge[] = edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      type: "smoothstep",
      label: e.label,
      animated: true,
      style: { stroke: "var(--accent)", strokeWidth: 1.5, opacity: 0.8 },
      labelStyle: { fill: "var(--accent-text)", fontSize: 10 },
      labelBgStyle: { fill: "var(--panel)" },
      labelBgPadding: [4, 2] as [number, number],
    }));
    const gh = (g.graph() as { height?: number }).height ?? 200;
    return { rfNodes, rfEdges, height: Math.min(Math.max(gh + 20, 180), 560), vertical };
  }, [nodes, edges]);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#07080d]">
      <p className="border-b border-white/[0.06] px-4 py-2 text-sm font-medium text-white" data-vertical={vertical || undefined}>
        {title}
      </p>
      <div style={{ height }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnScroll={false}
            preventScrolling={false}
            panOnDrag
            minZoom={0.3}
            maxZoom={1.4}
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
            style={{ background: "transparent" }}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
