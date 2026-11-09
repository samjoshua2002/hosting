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

function Ring({ value }: { value: number }) {
  const ref = useRef<SVGCircleElement>(null);
  const r = 46;
  const c = 2 * Math.PI * r;
  const color = value >= 85 ? "var(--good)" : value >= 60 ? "var(--warning)" : "var(--critical)";
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(ref.current, { strokeDashoffset: c }, { strokeDashoffset: c * (1 - value / 100), duration: 1.3, ease: "power3.out" });
      });
      mm.add("(prefers-reduced-motion: reduce)", () => {
        gsap.set(ref.current, { strokeDashoffset: c * (1 - value / 100) });
      });
      return () => mm.revert();
    },
    { dependencies: [value] },
  );
  return (
    <svg viewBox="0 0 110 110" className="size-[110px] -rotate-90">
      <circle cx="55" cy="55" r={r} fill="none" stroke="var(--track)" strokeWidth="9" />
      <circle ref={ref} cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c} />
    </svg>
  );
}

function Bars({ rows }: { rows: { label: string; n: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...rows.map((r) => r.n));
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(ref.current!.querySelectorAll("[data-bar]"), { scaleX: 0, transformOrigin: "left center", duration: 0.9, ease: "power3.out", stagger: 0.07 });
      });
      return () => mm.revert();
    },
    { scope: ref, dependencies: [rows.map((r) => r.n).join(",")] },
  );
  return (
    <div ref={ref} className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[86px_minmax(0,1fr)_28px] items-center gap-3 text-[12.5px]">
          <span className="text-zinc-400">{r.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-[var(--track)]">
            <span data-bar className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(r.n ? 6 : 0, (r.n / max) * 100)}%` }} />
          </span>
          <span className="text-right text-zinc-200 tabular-nums">{r.n}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- the row ---------- */

export function OverviewInsights({ vms, status }: { vms: VmInfo[]; status: Record<string, VmStatus | undefined> }) {
  const health = useMemo(() => healthOf(vms, status), [vms, status]);
  const mix = useMemo(() => {
    const seen = new Map<string, ProjectType>();
    for (const v of vms) for (const p of status[v.name]?.agent?.projects ?? []) seen.set(p.manifest.name, projectType(p.manifest));
    const order: ProjectType[] = ["website", "service", "worker", "database", "tool"];
    return order.map((t) => ({ label: TYPE_LABEL[t].many, n: [...seen.values()].filter((x) => x === t).length }));
  }, [vms, status]);
  const [ai, setAi] = useState<{ today: number; week: number; running: number; artifacts: number | null; autopilot?: { enabled: boolean; lastRun?: number; lastSummary?: string } } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [sessions, ap] = await Promise.all([
        api<{ sessions: { updatedAt: number; running?: boolean }[] }>("/api/sessions").catch(() => ({ sessions: [] })),
        api<{ enabled: boolean; lastRun?: number; lastSummary?: string }>("/api/autopilot").catch(() => undefined),
      ]);
      const now = Date.now();
      const list = sessions.sessions ?? [];
      if (!alive) return;
      setAi({ today: list.filter((s) => now - s.updatedAt < 86_400_000).length, week: list.filter((s) => now - s.updatedAt < 7 * 86_400_000).length, running: list.filter((s) => s.running).length, artifacts: null, autopilot: ap });
      const arts = await api<{ artifacts: unknown[] }>("/api/artifacts").catch(() => null);
      if (alive && arts) setAi((x) => (x ? { ...x, artifacts: arts.artifacts.length } : x));
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Stagger className="grid grid-cols-3 gap-4">
      <Card className="flex items-center gap-5 p-5">
        <div className="relative grid place-items-center">
          <Ring value={health.ready ? health.score : 0} />
          <div className="absolute text-center">
            <CountUp text={health.ready ? String(health.score) : "–"} className="block text-[26px] leading-none font-semibold text-white tabular-nums" />
            <span className="text-[10.5px] tracking-wide text-zinc-500 uppercase">health</span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-medium text-white">
            <Activity className="size-4 text-[var(--accent)]" /> Fleet health
          </p>
          {health.reasons.length ? (
            <ul className="mt-2 space-y-1 text-[12.5px] text-zinc-400">
              {health.reasons.map((r) => (
                <li key={r} className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-full bg-[var(--warning)]" /> {r}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[12.5px] text-zinc-400">{health.ready ? "Every machine up, nothing crashed, room on every disk." : "Checking the machines…"}</p>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <p className="mb-4 flex items-center gap-1.5 font-medium text-white">
          <Boxes className="size-4 text-[var(--accent)]" /> What&apos;s running
        </p>
        <Bars rows={mix} />
      </Card>

      <Card className="flex flex-col p-5">
        <p className="flex items-center gap-1.5 font-medium text-white">
          <Bot className="size-4 text-[var(--accent)]" /> Assistant
        </p>
        {!ai ? (
          <p className="mt-3 text-[12.5px] text-zinc-500">Loading…</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(
                [
                  ["today", String(ai.today)],
                  ["this week", String(ai.week)],
                  ["artifacts", ai.artifacts === null ? "…" : String(ai.artifacts)],
                ] as [string, string][]
              ).map(([l, v]) => (
                <div key={l} className="rounded-lg border border-[var(--line)] bg-[var(--panel-2)] px-2.5 py-2">
                  <CountUp text={v} className="block text-[20px] leading-tight font-semibold text-white tabular-nums" />
                  <span className="text-[11px] text-zinc-500">{l === "today" || l === "this week" ? `chats ${l}` : l}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 flex-1 text-[12px] leading-relaxed text-zinc-400">
              {ai.running ? (
                <span className={cx("mr-1 inline-flex items-center gap-1 text-[var(--accent)]")}>
                  <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]" /> {ai.running} working now ·
                </span>
              ) : null}
              {ai.autopilot?.enabled ? `Autopilot on${ai.autopilot.lastRun ? `, last check ${timeAgo(ai.autopilot.lastRun)}: ${(ai.autopilot.lastSummary ?? "").split("\n")[0].slice(0, 90)}` : ""}` : "Autopilot off"}
            </p>
            <Link href="/assistant" className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-accent-soft hover:underline">
              <Layers className="size-3.5" /> Open the Assistant
            </Link>
          </>
        )}
      </Card>
    </Stagger>
  );
}
