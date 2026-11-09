"use client";

// The Overview's deeper layer: a fleet health score, what's running by kind, and what the Assistant has been
// doing. Animated with GSAP (numbers count up, rings and bars draw in); reduced-motion users get the final state.
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Activity, Bot, Boxes, Layers } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import { projectType, TYPE_LABEL, type ProjectType } from "@/lib/project-type";
import type { VmInfo, VmStatus } from "@/lib/types";
import { Bar, BarChart, LabelList, PolarAngleAxis, RadialBar, RadialBarChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Card, cx } from "./ui";

gsap.registerPlugin(useGSAP);

/** Text whose numbers count up from zero (e.g. "5/6", "10.4 GB"). */
export function CountUp({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const played = useRef(false);
  useGSAP(
    () => {
      // write into React's own text node (replacing it would leave React updating a detached node)
      const node = ref.current?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const set = (v: string) => (node.nodeValue = v);
      // count up once, on first sight; live refreshes after that just show the new value
      if (played.current || !/\d/.test(text)) {
        set(text);
        return;
      }
      played.current = true;
      const parts = text.split(/(\d+(?:\.\d+)?)/);
      const nums = parts.map((p, i) => (i % 2 === 1 ? Number(p) : null));
      const decimals = parts.map((p, i) => (i % 2 === 1 && p.includes(".") ? p.split(".")[1].length : 0));
      const state = { t: 0 };
      const render = () => {
        set(parts.map((p, i) => (nums[i] === null ? p : (nums[i]! * state.t).toFixed(decimals[i]))).join(""));
      };
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        render();
        gsap.to(state, { t: 1, duration: 1.1, ease: "power3.out", onUpdate: render, onComplete: () => set(text) });
      });
      return () => {
        mm.revert();
        set(text);
      };
    },
    { dependencies: [text] },
  );
  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}

/** Children appear in a quick stagger (cards, rows). */
export function Stagger({ children, className, selector = ":scope > *" }: { children: React.ReactNode; className?: string; selector?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(ref.current!.querySelectorAll(selector), { y: 14, opacity: 0, duration: 0.55, ease: "power3.out", stagger: 0.06, clearProps: "transform,opacity" });
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/* ---------- health ---------- */

function healthOf(vms: VmInfo[], status: Record<string, VmStatus | undefined>) {
  const known = vms.filter((v) => status[v.name]);
  const online = known.filter((v) => status[v.name]?.ok).length;
  const reasons: string[] = [];
  let score = 100;
  if (known.length) {
    const down = known.length - online;
    if (down) {
      score -= Math.min(35, down * 12);
      reasons.push(`${down} machine${down > 1 ? "s" : ""} resting`);
    }
  }
  let crashed = 0;
  let disk = 0;
  let mem = 0;
  for (const v of vms) {
    const a = status[v.name]?.agent;
    if (!a) continue;
    crashed += a.projects.filter((p) => p.active === "failed").length;
    if (a.diskTotalKb && a.diskUsedKb / a.diskTotalKb > 0.85) disk++;
    if (a.memTotalKb && 1 - a.memAvailKb / a.memTotalKb > 0.9) mem++;
  }
  if (crashed) {
    score -= Math.min(30, crashed * 10);
    reasons.push(`${crashed} crashed service${crashed > 1 ? "s" : ""}`);
  }
  if (disk) {
    score -= disk * 8;
    reasons.push(`${disk} disk${disk > 1 ? "s" : ""} nearly full`);
  }
  if (mem) {
    score -= mem * 6;
    reasons.push(`${mem} machine${mem > 1 ? "s" : ""} low on memory`);
  }
  return { score: Math.max(0, Math.round(score)), reasons, ready: known.length > 0 };
}

/* shadcn-style card: header (title + description), content, footer */
function InsightCard({ title, description, footer, children, className }: { title: string; description: string; footer?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cx("flex flex-col", className)}>
      <div className="space-y-1 px-6 pt-5">
        <p className="text-[15px] leading-none font-semibold tracking-tight text-white">{title}</p>
        <p className="text-[13px] text-muted">{description}</p>
      </div>
      <div className="flex flex-1 items-center px-6 py-3">{children}</div>
      {footer && <div className="flex flex-col gap-1 border-t border-[var(--line)] px-6 py-3.5 text-[13px]">{footer}</div>}
    </Card>
  );
}

/** Radial score, like shadcn's "Radial Chart - Shape": a thin rounded arc on a muted ring, the number in the middle. */
function ScoreChart({ value, ready }: { value: number; ready: boolean }) {
  const color = !ready ? "var(--line-strong)" : value >= 85 ? "var(--good)" : value >= 60 ? "var(--warning)" : "var(--critical)";
  const data = [{ name: "health", value: ready ? value : 0, fill: color }];
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[180px]">
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart data={data} startAngle={90} endAngle={-270} innerRadius="78%" outerRadius="100%">
          <RadialBar dataKey="value" background={{ fill: "var(--track)" }} cornerRadius={10} isAnimationActive animationDuration={1100} />
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        <div>
          <CountUp text={ready ? String(value) : "–"} className="block text-[34px] leading-none font-bold tracking-tight text-white tabular-nums" />
          <span className="mt-1 block text-[12px] text-muted">out of 100</span>
        </div>
      </div>
    </div>
  );
}

/** Horizontal bars with the value at the end, like shadcn's "Bar Chart - Custom Label". */
function MixChart({ rows }: { rows: { label: string; n: number }[] }) {
  return (
    <div className="h-[178px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 28, top: 4, bottom: 4 }} barCategoryGap={7}>
          <XAxis type="number" hide domain={[0, (max: number) => Math.max(1, max)]} />
          <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={78} tick={{ fill: "var(--muted)", fontSize: 12.5 }} />
          <Bar dataKey="n" fill="var(--accent)" radius={6} background={{ fill: "var(--panel-2)", radius: 6 }} animationDuration={900}>
            <LabelList dataKey="n" position="right" offset={8} className="fill-[var(--text)]" fontSize={12.5} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---------- the row ---------- */

type AiStats = { ok: boolean; today: number; week: number; running: number; artifacts: number | null; autopilot?: { enabled: boolean; lastRun?: number; lastSummary?: string } };

export function OverviewInsights({ vms, status }: { vms: VmInfo[]; status: Record<string, VmStatus | undefined> }) {
  const health = useMemo(() => healthOf(vms, status), [vms, status]);
  const mix = useMemo(() => {
    const seen = new Map<string, ProjectType>();
    for (const v of vms) for (const p of status[v.name]?.agent?.projects ?? []) seen.set(p.manifest.name, projectType(p.manifest));
    const order: ProjectType[] = ["website", "service", "worker", "database", "tool"];
    return order.map((t) => ({ label: TYPE_LABEL[t].many, n: [...seen.values()].filter((x) => x === t).length }));
  }, [vms, status]);
  const total = mix.reduce((a, r) => a + r.n, 0);
  const [ai, setAi] = useState<AiStats | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [sessions, ap] = await Promise.all([
        api<{ sessions: { updatedAt: number; running?: boolean }[] }>("/api/sessions").catch(() => null),
        api<{ enabled: boolean; lastRun?: number; lastSummary?: string }>("/api/autopilot").catch(() => undefined),
      ]);
      if (!alive) return;
      const now = Date.now();
      const list = sessions?.sessions ?? [];
      setAi({ ok: Boolean(sessions), today: list.filter((s) => now - s.updatedAt < 86_400_000).length, week: list.filter((s) => now - s.updatedAt < 7 * 86_400_000).length, running: list.filter((s) => s.running).length, artifacts: null, autopilot: ap });
      const arts = await api<{ artifacts: unknown[] }>("/api/artifacts").catch(() => null);
      if (alive) setAi((x) => (x ? { ...x, artifacts: arts ? arts.artifacts.length : -1 } : x));
    })();
    return () => {
      alive = false;
    };
  }, []);
  const stat = (n: number | null | undefined) => (!ai?.ok || n === -1 ? "–" : n === null || n === undefined ? "…" : String(n));

  return (
    <Stagger className="grid grid-cols-3 gap-4">
      <InsightCard
        title="Fleet health"
        description="Machines, crashes, disk and memory"
        footer={
          health.reasons.length ? (
            health.reasons.map((r) => (
              <span key={r} className="flex items-center gap-2 text-zinc-300">
                <span className="size-1.5 shrink-0 rounded-full bg-[var(--warning)]" /> {r}
              </span>
            ))
          ) : (
            <span className="flex items-center gap-2 text-zinc-300">
              <Activity className="size-4 text-[var(--good)]" /> {health.ready ? "All clear: every machine up, nothing crashed" : "Checking the machines…"}
            </span>
          )
        }
      >
        <ScoreChart value={health.score} ready={health.ready} />
      </InsightCard>

      <InsightCard
        title="What's running"
        description="Projects by kind, across every machine"
        footer={
          <span className="flex items-center gap-2 text-zinc-300">
            <Boxes className="size-4 text-[var(--accent)]" /> {total} project{total === 1 ? "" : "s"} in total
          </span>
        }
      >
        <MixChart rows={mix} />
      </InsightCard>

      <InsightCard
        title="Assistant"
        description="Conversations and what they produced"
        footer={
          <>
            <span className="text-zinc-300">
              {!ai ? "Loading…" : !ai.ok ? "Can't reach the storage machine right now" : ai.autopilot?.enabled ? `Autopilot on${ai.autopilot.lastRun ? ` · checked ${timeAgo(ai.autopilot.lastRun)}` : ""}` : "Autopilot off"}
            </span>
            <Link href="/assistant" className="inline-flex items-center gap-1 text-muted hover:text-white">
              <Bot className="size-3.5" /> Open the Assistant
            </Link>
          </>
        }
      >
        <div className="grid w-full grid-cols-3 divide-x divide-[var(--line)]">
          {(
            [
              ["Today", stat(ai ? ai.today : null)],
              ["This week", stat(ai ? ai.week : null)],
              ["Artifacts", ai ? stat(ai.artifacts) : "…"],
            ] as [string, string][]
          ).map(([l, v]) => (
            <div key={l} className="px-3 first:pl-0">
              <p className="text-[12px] text-muted">{l}</p>
              <CountUp text={v} className="mt-1 block text-[30px] leading-none font-bold tracking-tight text-white tabular-nums" />
            </div>
          ))}
        </div>
        {ai?.running ? (
          <span className="ml-2 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--accent)]">
            <Layers className="size-3" /> {ai.running} working
          </span>
        ) : null}
      </InsightCard>
    </Stagger>
  );
}
