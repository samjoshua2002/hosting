"use client";

import { AlertTriangle, ChevronRight, Layers, Server, Shuffle, SquareTerminal, Table2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Suggestions } from "@/components/ai-recs";
import { ColumnChart, Segmented } from "@/components/charts";
import { useCluster } from "@/components/cluster";
import { PhotoCredit, UnsplashLayer, shuffleTheme, useTheme } from "@/components/theme";
import { Card, Empty, Meter, StatusDot, cx } from "@/components/ui";
import { METRICS, RANGES, buildBuckets, fmtClock, totals, type Metric, type RangeId } from "@/lib/analytics";
import { useStored } from "@/lib/client";
import { fmtDuration, fmtKb, pct, timeAgo, vmMetrics, vmState } from "@/lib/format";
import { findProblems } from "@/lib/health";

const NOUN: Record<Metric, string> = { cpu: "CPU", memory: "Memory", storage: "Storage" };

export default function OverviewPage() {
  const { vms, status, history, checking, loaded, configErrors } = useCluster();
  const { photo } = useTheme();
  const [shuffling, setShuffling] = useState(false);
  const [metric, setMetric] = useStored<Metric>("hosting.metric", "cpu");
  const [range, setRange] = useStored<RangeId>("hosting.range", "1h");
  const [table, setTable] = useState(false);
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
  const problems = useMemo(
    () => findProblems(vms.filter((v) => status[v.name] && !checking[v.name]).map((v) => status[v.name]!)),
    [vms, status, checking],
  );
  const valued = buckets.filter((b) => b.value !== null);
  const avg = valued.length ? valued.reduce((s, b) => s + (b.value ?? 0), 0) / valued.length : 0;

  return (
    <div className="relative isolate">
      <UnsplashLayer photo={photo} className="page-cover" />
      <div className="mx-auto max-w-6xl space-y-5 px-8 pt-12 pb-12">
        <header className="flex items-center gap-6">
          <UnsplashLayer photo={photo} className="grid size-32 shrink-0 place-items-center rounded-3xl shadow-2xl ring-1 ring-white/10">
            <Layers className="size-14 text-white drop-shadow-lg" strokeWidth={1.75} />
          </UnsplashLayer>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold tracking-[0.14em] text-ink/90 uppercase">Command center</p>
            <h1 className="mt-1 text-6xl font-extrabold tracking-[-0.03em] text-white">Fleet Overview</h1>
            <p className="mt-2 text-[15px] text-ink/75">
              {vms.length || "…"} machine{vms.length === 1 ? "" : "s"} · {t.online} online · {t.projectsLive} project{t.projectsLive === 1 ? "" : "s"} live
            </p>
          </div>
          <button
            onClick={async () => {
              setShuffling(true);
              await shuffleTheme();
              setShuffling(false);
            }}
            className="self-start rounded-full border border-white/15 bg-white/5 p-2.5 text-ink backdrop-blur hover:bg-white/10"
            title="New Unsplash photo and theme"
            aria-label="New theme"
          >
            <Shuffle className={cx("size-4", shuffling && "animate-spin")} />
          </button>
        </header>

        {configErrors.length > 0 && (
          <Card className="border-[var(--warning)]/40 p-4 text-sm text-ink">
            {configErrors.map((e) => (
              <p key={e}>{e}</p>
            ))}
          </Card>
        )}

        {problems.length > 0 && (
          <Card className="border-[var(--critical)]/40 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--critical-text)]" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white">
                  {problems.length} thing{problems.length > 1 ? "s" : ""} need{problems.length === 1 ? "s" : ""} attention
                </p>
                <ul className="mt-1 space-y-0.5 text-sm text-ink/80">
                  {problems.map((p) => (
                    <li key={p.title}>
                      {p.title}
                      {p.detail && <span className="text-muted"> · {p.detail}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <Link href="/assistant" className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-[#0b0e1c]">
                Investigate
              </Link>
            </div>
          </Card>
        )}

        {loaded && vms.length === 0 ? (
          <Card>
            <Empty icon={<Server className="size-8" />} title="No machines configured">
              Add them to the <code className="text-white">VMS</code> environment variable. See{" "}
              <Link href="/machines" className="text-accent-soft underline">
                Machines
              </Link>
              .
            </Empty>
          </Card>
        ) : (
          <>
            {/* the numbers that matter */}
            <Card className="grid grid-cols-5 divide-x divide-white/[0.06]">
              <Stat label="Machines" value={`${t.online}/${t.total}`} sub="online" />
              <Stat label="CPU" value={`${t.cpuAvg.toFixed(t.cpuAvg < 10 ? 1 : 0)}%`} sub={`of ${t.cores} vCPU`} />
              <Stat label="Memory" value={fmtKb(t.memUsed)} sub={`of ${fmtKb(t.memTotal)} · ${pct(t.memUsed, t.memTotal)}%`} />
              <Stat label="Storage" value={fmtKb(t.diskUsed)} sub={`of ${fmtKb(t.diskTotal)} · ${fmtKb(Math.max(0, t.diskTotal - t.diskUsed))} free`} />
              <Stat label="Projects" value={`${t.projectsLive}/${t.projects}`} sub={t.jobsRunning ? `${t.jobsRunning} job${t.jobsRunning > 1 ? "s" : ""} running` : "running"} />
            </Card>

            {/* every machine, one row each */}
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between px-6 pt-5 pb-3">
                <h2 className="text-[17px] font-semibold text-white">Machines</h2>
                <Link href="/machines" className="flex items-center gap-0.5 text-xs font-semibold text-accent-soft hover:text-white">
                  Manage <ChevronRight className="size-3.5" />
                </Link>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="border-y border-white/[0.06] text-xs text-muted">
                  <tr>
                    <th className="px-6 py-2 font-medium">Machine</th>
                    <th className="w-[17%] px-3 py-2 font-medium">CPU</th>
                    <th className="w-[17%] px-3 py-2 font-medium">Memory</th>
                    <th className="w-[17%] px-3 py-2 font-medium">Disk</th>
                    <th className="px-3 py-2 font-medium">Projects</th>
                    <th className="px-3 py-2 font-medium">Uptime</th>
                    <th className="px-6 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {vms.map((v) => {
                    const s = status[v.name];
                    const st = vmState(s, Boolean(checking[v.name]));
                    const m = vmMetrics(s);
                    const a = s?.agent;
                    return (
                      <tr key={v.name} className="hover:bg-white/[0.02]">
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2.5">
                            <StatusDot state={st} />
                            <div className="min-w-0">
                              <p className="font-mono font-semibold text-white">{v.name}</p>
                              <p className="truncate text-[11px] text-muted">
                                {st === "checking" ? "waking up…" : st === "offline" ? (s?.error ?? "unreachable") : (a?.hostname ?? v.host)}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">{m ? <Meter label="" value={m.cpu} detail={`${m.cpu}%`} /> : <Dash />}</td>
                        <td className="px-3 py-3">{m ? <Meter label="" value={m.memPct} detail={fmtKb(m.memUsedKb)} /> : <Dash />}</td>
                        <td className="px-3 py-3">{m ? <Meter label="" value={m.diskPct} detail={`${fmtKb(m.diskTotalKb - m.diskUsedKb)} free`} /> : <Dash />}</td>
                        <td className="px-3 py-3 text-ink/80">
                          {a ? (a.projects.length ? `${a.projects.filter((p) => p.active === "active").length}/${a.projects.length} live` : "none") : <Dash />}
                        </td>
                        <td className="px-3 py-3 text-ink/80">{a ? fmtDuration(a.uptimeSec) : <Dash />}</td>
                        <td className="px-6 py-3 text-right">
                          <Link
                            href={`/run?vm=${v.name}`}
                            className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-xs text-ink hover:bg-white/5"
                          >
                            <SquareTerminal className="size-3.5" /> Run
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>

            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5">
              {/* usage over time */}
              <Card className="p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold text-white">{NOUN[metric]} over time</h2>
                    <p className="mt-0.5 text-xs text-muted">
                      Fleet average · last {r.words} · <span className="text-ink">{avg.toFixed(avg < 10 ? 1 : 0)}%</span> on average
                    </p>
                  </div>
                  <button
                    onClick={() => setTable((x) => !x)}
                    className="flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-muted hover:text-white"
                    aria-pressed={table}
                  >
                    <Table2 className="size-3" /> {table ? "Chart" : "Table"}
                  </button>
                </div>
                <div className="mt-4 mb-5 flex items-center justify-between gap-3">
                  <Segmented value={metric} options={METRICS} onChange={setMetric} size="sm" />
                  <Segmented value={range} options={RANGES.map((x) => ({ id: x.id, label: x.label }))} onChange={setRange} size="sm" />
                </div>
                {table ? (
                  <div className="scroll-thin max-h-56 overflow-auto rounded-lg border border-white/[0.06]">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-panel text-muted">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">Window</th>
                          <th className="px-3 py-1.5 text-right font-medium">{NOUN[metric]}</th>
                          <th className="px-3 py-1.5 text-right font-medium">Machines reporting</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {buckets
                          .filter((b) => b.value !== null)
                          .map((b) => (
                            <tr key={b.start} className="border-t border-white/[0.04]">
                              <td className="px-3 py-1.5 text-ink/80">
                                {fmtClock(b.start)}–{fmtClock(b.end)}
                              </td>
                              <td className="px-3 py-1.5 text-right text-white">{b.value!.toFixed(1)}%</td>
                              <td className="px-3 py-1.5 text-right text-muted">{b.reporting}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : now > 0 ? (
                  <ColumnChart buckets={buckets} emptyText="History builds up while this page is open" />
                ) : (
                  <div className="h-[244px]" />
                )}
              </Card>
              <Suggestions />
            </div>
          </>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-muted">
            Checked {timeAgo(Math.max(0, ...vms.map((v) => status[v.name]?.checkedAt ?? 0)))}
            {Object.values(checking).some(Boolean) && " · refreshing…"}
          </span>
          <PhotoCredit photo={photo} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="px-6 py-5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-[28px] font-bold tracking-tight text-white">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted">{sub}</p>
    </div>
  );
}

function Dash() {
  return <span className="text-muted">—</span>;
}
