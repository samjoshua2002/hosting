"use client";

import { AlertTriangle, ArrowRight, FolderGit2, HardDrive, MemoryStick, MessagesSquare, Rocket, Search, Server, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Suggestions } from "@/components/ai-recs";
import { ColumnChart, Segmented } from "@/components/charts";
import { useCluster } from "@/components/cluster";
import { CountUp, OverviewInsights, Stagger } from "@/components/overview-insights";
import { Card, Empty, cx } from "@/components/ui";
import { METRICS, RANGES, buildBuckets, totals, type Metric, type RangeId } from "@/lib/analytics";
import { useStored } from "@/lib/client";
import { fmtKb, vmMetrics, vmState } from "@/lib/format";
import { findProblems, investigatePrompt } from "@/lib/health";
import { startChat } from "@/components/assistant-store";
import { useRouter } from "next/navigation";
import type { JobState } from "@/lib/types";

const NOUN: Record<Metric, string> = { cpu: "CPU", memory: "Memory", storage: "Storage" };

export default function OverviewPage() {
  const { vms, status, history, checking, loaded, configErrors } = useCluster();
  const [metric, setMetric] = useStored<Metric>("hosting.metric", "cpu");
  const [range, setRange] = useStored<RangeId>("hosting.range", "1h");
  // 0 until mounted: the clock can't be read during prerender (and would be stale anyway)
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const names = useMemo(() => vms.map((v) => v.name), [vms]);
  const r = RANGES.find((x) => x.id === range) ?? RANGES[1];
  const buckets = useMemo(() => buildBuckets(names, history, status, metric, r.sec, now), [names, history, status, metric, r.sec, now]);
  const t = useMemo(() => totals(vms, status), [vms, status]);
  const router = useRouter();
  const problems = useMemo(() => findProblems(vms.filter((v) => status[v.name] && !checking[v.name]).map((v) => status[v.name]!)), [vms, status, checking]);
  const valued = buckets.filter((b) => b.value !== null);
  const avg = valued.length ? valued.reduce((s, b) => s + (b.value ?? 0), 0) / valued.length : 0;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
      <header className="flex min-h-[150px] items-end justify-between gap-4 pt-16 [text-shadow:0_1px_12px_rgb(0_0_0/0.6)]">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Overview</h1>
          <p className="mt-1.5 text-sm text-zinc-300">Here is the summary of your fleet</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented value={range} options={RANGES.map((x) => ({ id: x.id, label: x.label }))} onChange={setRange} size="sm" />
          <Link href="/assistant" className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-3 text-sm text-zinc-200 hover:bg-white/5">
            <MessagesSquare className="size-4 text-[var(--accent)]" /> Ask the Assistant
          </Link>
        </div>
      </header>

      {configErrors.length > 0 && (
        <Card className="p-4 text-sm text-ink">
          {configErrors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </Card>
      )}

      {problems.length > 0 && (
        <Card className="flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--critical-text)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white">
              {problems.length} thing{problems.length > 1 ? "s" : ""} need{problems.length === 1 ? "s" : ""} attention
            </p>
            <ul className="mt-1 space-y-0.5 text-sm text-zinc-400">
              {problems.map((p) => (
                <li key={p.title}>
                  {p.title}
                  {p.detail && <span className="text-muted"> · {p.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
          <button
            onClick={() => {
              startChat(investigatePrompt(problems), `Investigate: ${problems.map((p) => p.title).join(", ")}`);
              router.push("/assistant");
            }}
            className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:brightness-110"
          >
            Investigate
          </button>
        </Card>
      )}

      {loaded && vms.length === 0 ? (
        <Card>
          <Empty icon={<Server className="size-8" />} title="No machines yet">
            <Link href="/machines?add=1" className="text-accent-soft underline">
              Add a machine
            </Link>{" "}
            by pasting its SSH command.
          </Empty>
        </Card>
      ) : (
        <>
          <Stagger className="grid grid-cols-4 gap-4">
            <StatCard icon={Server} title="Machines" sub="Online right now" value={`${t.online}/${t.total}`} badge={t.online === t.total ? "all up" : `${t.total - t.online} resting`} good={t.online === t.total} href="/machines" footer="Manage machines" />
            <StatCard
              icon={FolderGit2}
              title="Projects"
              sub={t.jobsRunning ? `${t.jobsRunning} job${t.jobsRunning > 1 ? "s" : ""} running` : "Live right now"}
              value={`${t.projectsLive}/${t.projects}`}
              badge={t.projectsLive === t.projects ? "healthy" : `${t.projects - t.projectsLive} down`}
              good={t.projectsLive === t.projects}
              href="/projects"
              footer="View projects"
            />
            <StatCard icon={MemoryStick} title="Memory" sub={`of ${fmtKb(t.memTotal)} in total`} value={fmtKb(t.memUsed)} badge={`${pct(t.memUsed, t.memTotal)}% used`} good={pct(t.memUsed, t.memTotal) < 80} href="#usage" footer="See usage" />
            <StatCard
              icon={HardDrive}
              title="Storage"
              sub={`of ${fmtKb(t.diskTotal)} in total`}
              value={fmtKb(t.diskUsed)}
              badge={`${pct(t.diskUsed, t.diskTotal)}% used`}
              good={pct(t.diskUsed, t.diskTotal) < 80}
              href="/machines"
              footer="See machines"
            />
          </Stagger>

          <OverviewInsights vms={vms} status={status} />

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] gap-4">
            <Card className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-white">Machines</h2>
                  <p className="text-xs text-muted">
                    {t.cores} vCPU · {fmtKb(t.memTotal)} RAM in total
                  </p>
                </div>
                <Link href="/machines?add=1" className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line-strong)] px-3 text-xs text-zinc-200 hover:bg-white/5">
                  <span className="text-[var(--accent)]">+</span> Add new
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {vms.map((v) => {
                  const s = status[v.name];
                  const st = vmState(s, Boolean(checking[v.name]));
                  const m = vmMetrics(s);
                  const a = s?.agent;
                  const resting = /cool|paus/i.test(s?.error ?? "");
                  return (
                    <div key={v.name} className="rounded-xl border border-[var(--line)] bg-[var(--panel-2)] p-3">
                      <div className="flex items-center gap-2">
                        <span className="grid size-7 place-items-center rounded-md border border-[var(--line)] bg-[var(--panel)]">
                          <Server className="size-3.5 text-[var(--accent)]" />
                        </span>
                        <span className="font-mono text-sm font-medium text-white">{v.name}</span>
                        <span className="flex-1" />
                        <Link href={`/run?vm=${v.name}`} className="text-zinc-500 hover:text-white" title={`Open a shell on ${v.name}`} aria-label={`Open a shell on ${v.name}`}>
                          <SquareTerminal className="size-4" />
                        </Link>
                      </div>
                      <p className="mt-3 text-xl font-semibold tabular-nums text-white">
                        {m ? `${m.cpu}%` : "—"} <span className="text-xs font-normal text-muted">CPU</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted">{m ? `${fmtKb(m.memUsedKb)} RAM · ${fmtKb(m.diskTotalKb - m.diskUsedKb)} disk free` : (s?.error?.slice(0, 48) ?? "checking…")}</p>
                      <p className={cx("mt-1.5 text-[11px] font-medium", st === "online" ? "text-[var(--good-text)]" : st === "checking" ? "text-[var(--warning)]" : "text-[var(--critical-text)]")}>
                        {st === "online" ? `Active · ${a?.projects.length ?? 0} project${a?.projects.length === 1 ? "" : "s"}` : st === "checking" ? "Checking…" : resting ? "Resting (InstaBox limit)" : "Unreachable"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card id="usage" className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-muted">{NOUN[metric]} · fleet average</p>
                  <p className="mt-1 text-[28px] font-semibold tracking-tight text-white tabular-nums">{avg.toFixed(avg < 10 ? 1 : 0)}%</p>
                  <p className="text-xs text-muted">last {r.words}</p>
                </div>
                <Segmented value={metric} options={METRICS} onChange={setMetric} size="sm" />
              </div>
              {/* the chart takes the card's full height, so the row has no dead space next to the machines */}
              <div className="mt-4 flex min-h-[260px] flex-1 flex-col">
                {now > 0 ? <ColumnChart buckets={buckets} height="fill" emptyText="History builds up while this page is open" /> : <div className="flex-1" />}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4">
            <RecentActivity />
            <Suggestions />
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  title,
  sub,
  value,
  badge,
  good,
  href,
  footer,
}: {
  icon: typeof Server;
  title: string;
  sub: string;
  value: string;
  badge?: string;
  good?: boolean;
  href: string;
  footer: string;
}) {
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex-1 p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--panel-2)]">
            <Icon className="size-[18px] text-[var(--accent)]" />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-white">{title}</p>
            <p className="truncate text-xs text-muted">{sub}</p>
          </div>
        </div>
        <div className="mt-4 flex items-baseline justify-between gap-2">
          <CountUp text={value} className="block text-[26px] font-semibold tracking-tight text-white tabular-nums" />
          {badge && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] font-medium text-muted">
              <span className={cx("size-1.5 rounded-full shrink-0", good ? "bg-[var(--good)]" : "bg-[var(--warning)]")} />
              <span className="tabular-nums">{badge}</span>
            </span>
          )}
        </div>
      </div>
      <Link href={href} className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3 text-sm text-zinc-400 hover:bg-white/[0.02] hover:text-white">
        {footer}
        <ArrowRight className="size-4 text-[var(--accent)]" />
      </Link>
    </Card>
  );
}

type Filter = "all" | "deploy" | "command" | "failed";

/** Deploys and jobs across the fleet, newest first. */
function RecentActivity() {
  const { vms, status, openJob } = useCluster();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(
    () =>
      vms
        .flatMap((v) => (status[v.name]?.agent?.jobs ?? []).map((j) => ({ vm: v.name, j })))
        .sort((a, b) => b.j.meta.startedAt - a.j.meta.startedAt)
        .filter(({ j }) => (filter === "all" ? true : filter === "failed" ? j.state === "done" && j.exitCode !== 0 : j.meta.kind === filter))
        .filter(({ vm, j }) => !q || `${j.meta.label} ${vm}`.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 8),
    [vms, status, q, filter],
  );
  const state = (j: JobState): { text: string; cls: string } =>
    j.state === "running" ? { text: "Running", cls: "bg-[var(--warning)]" } : j.state === "done" && j.exitCode === 0 ? { text: "Completed", cls: "bg-[var(--good)]" } : j.state === "lost" ? { text: "Stopped", cls: "bg-zinc-500" } : { text: "Failed", cls: "bg-[var(--critical)]" };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <h2 className="flex-1 text-base font-semibold text-white">Recent activity</h2>
        <label className="flex h-8 w-48 items-center gap-2 rounded-lg border border-[var(--line-strong)] px-2.5">
          <Search className="size-3.5 text-[var(--accent)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="w-full bg-transparent text-xs text-white outline-none placeholder:text-muted" />
        </label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="h-8 rounded-lg border border-[var(--line-strong)] bg-transparent px-2 text-xs text-zinc-300">
          <option value="all">All</option>
          <option value="deploy">Deploys</option>
          <option value="command">Commands</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      {/* fixed layout: a long command truncates instead of pushing Date/Time/Status off the card */}
      <table className="w-full table-fixed text-left text-sm">
        <thead className="border-y border-[var(--line)] bg-white/[0.015] text-xs text-muted">
          <tr>
            <th className="px-5 py-2.5 font-medium">Activity</th>
            <th className="w-[76px] px-3 py-2.5 font-medium">Machine</th>
            <th className="w-[72px] px-3 py-2.5 font-medium">Date</th>
            <th className="w-[60px] px-3 py-2.5 font-medium">Time</th>
            <th className="w-[112px] px-5 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--line)]">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-5 py-8 text-center text-sm text-muted">
                Nothing yet.
              </td>
            </tr>
          ) : (
            rows.map(({ vm, j }) => {
              const s = state(j);
              const d = new Date(j.meta.startedAt * 1000);
              return (
                <tr key={`${vm}-${j.id}`} onClick={() => openJob({ vm, id: j.id, title: j.meta.label })} className="cursor-pointer hover:bg-white/[0.02]">
                  <td className="px-5 py-3">
                    <span className="flex min-w-0 items-center gap-2.5" title={j.meta.label}>
                      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-[var(--line)] bg-[var(--panel-2)]">
                        {j.meta.kind === "deploy" ? <Rocket className="size-3.5 text-[var(--accent)]" /> : <SquareTerminal className="size-3.5 text-[var(--accent)]" />}
                      </span>
                      {(() => {
                        const parts = j.meta.label.split(" · ");
                        const main = parts[0];
                        const trigger = parts.slice(1).join(" · ");
                        return (
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-white font-medium">{main}</span>
                            {trigger && (
                              <span className="shrink-0 rounded border border-[var(--line-strong)] bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-muted">
                                {trigger}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-zinc-400">{vm}</td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap text-zinc-400">{d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap text-zinc-400">{d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-zinc-300">
                      <span className={cx("size-1.5 shrink-0 rounded-full", s.cls)} /> <span className="truncate">{s.text}</span>
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </Card>
  );
}
