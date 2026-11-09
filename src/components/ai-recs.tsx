"use client";

import { ArrowUpRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useCluster } from "./cluster";
import { Card, cx } from "./ui";

interface Rec {
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  vm: string | null;
  command: string | null;
}

const KEY = "hosting.suggestions";
const TTL = 10 * 60 * 1000;

function cached(): { recs: Rec[]; at: number } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    return v && Date.now() - v.at < TTL ? v : null;
  } catch {
    return null;
  }
}

/** Short, specific suggestions from the assistant, based on the live numbers on this page (no SSH needed). */
export function Suggestions() {
  const { vms, status, checking } = useCluster();
  const [data, setData] = useState<{ recs: Rec[]; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const ready = vms.length > 0 && vms.every((v) => status[v.name] && !checking[v.name]);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    const snapshot = {
      vms: vms.map((v) => {
        const s = status[v.name];
        const a = s?.agent;
        if (!s?.ok || !a) return { name: v.name, reachable: false, error: s?.error };
        return {
          name: v.name,
          reachable: true,
          cpuPct: a.cpuPct,
          load: a.load,
          cores: a.cores,
          memUsedPct: Math.round(((a.memTotalKb - a.memAvailKb) * 100) / a.memTotalKb),
          diskUsedPct: Math.round((a.diskUsedKb * 100) / a.diskTotalKb),
          diskFreeGB: +((a.diskTotalKb - a.diskUsedKb) / 1048576).toFixed(1),
          uptimeMin: Math.round(a.uptimeSec / 60),
          docker: a.docker,
          projects: a.projects.map((p) => ({ name: p.manifest.name, state: p.active, port: p.manifest.port })),
          jobsRunning: a.jobs.filter((j) => j.state === "running").length,
          recentFailedJobs: a.jobs.filter((j) => j.state === "done" && j.exitCode !== 0).map((j) => j.meta.label).slice(0, 3),
        };
      }),
    };
    try {
      const res = await api<{ recommendations: Rec[]; at: number }>("/api/ai/recommend", { snapshot });
      const next = { recs: res.recommendations, at: res.at };
      setData(next);
      try {
        sessionStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [vms, status]);

  useEffect(() => {
    if (started.current || !ready) return;
    started.current = true;
    const hit = cached();
    queueMicrotask(() => (hit ? setData(hit) : void load()));
  }, [ready, load]);

  return (
    <Card className="flex flex-col p-6">
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold tracking-tight text-[var(--text)]">Fleet Diagnostics</h2>
          {data && data.recs.length > 0 && (
            <span className="rounded-md border border-[var(--line-strong)] bg-[var(--panel-2)] px-2 py-0.5 font-mono text-[10px] font-medium text-muted tabular-nums">
              {data.recs.length} notice{data.recs.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <button
          onClick={() => void load()}
          disabled={busy || !ready}
          className="rounded-lg border border-[var(--line)] p-1.5 text-muted hover:border-[var(--line-strong)] hover:text-[var(--text)] disabled:opacity-40 transition-colors"
          aria-label="Refresh diagnostics"
          title="Refresh diagnostics"
        >
          <RefreshCw className={cx("size-3.5", busy && "animate-spin")} />
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-[var(--critical-text)]">{error}</p>}
      {!data && !error && (
        <p className="mt-4 text-xs text-muted">
          {ready ? "Analyzing fleet telemetry and logs…" : "Waiting for machines to report…"}
        </p>
      )}

      {data && (
        <div className={cx("mt-3 flex-1 space-y-3.5", busy && "opacity-60")}>
          {data.recs.map((r, idx) => {
            const isCrit = r.severity === "critical";
            const isWarn = r.severity === "warning";
            const tagLabel = isCrit ? "CRITICAL" : isWarn ? "ADVISORY" : "NOTICE";
            const tagCls = isCrit
              ? "border-[var(--critical)]/40 bg-[var(--critical)]/10 text-[var(--critical-text)]"
              : isWarn
              ? "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]"
              : "border-[var(--line-strong)] bg-[var(--panel-2)] text-muted";

            return (
              <div key={idx} className="rounded-xl border border-[var(--line)] bg-[var(--panel-2)]/50 p-3.5 transition-colors hover:border-[var(--line-strong)]">
                <div className="flex items-center justify-between gap-2">
                  <span className={cx("rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase border", tagCls)}>
                    {tagLabel}
                  </span>
                  {r.vm && (
                    <span className="rounded border border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      {r.vm}
                    </span>
                  )}
                </div>

                <p className="mt-2 text-xs font-medium text-[var(--text)] leading-snug">
                  {r.title}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  {r.detail}
                </p>

                {r.command && (
                  <Link
                    href={`/run?${new URLSearchParams({ ...(r.vm ? { vm: r.vm } : {}), cmd: r.command })}`}
                    className="mt-2.5 flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 hover:border-[var(--accent)] hover:text-white transition-colors group"
                    title="Opens command in Run console"
                  >
                    <span className="truncate pr-2">$ {r.command}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted group-hover:text-[var(--accent)]">
                      Run <ArrowUpRight className="size-3" />
                    </span>
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Link
        href="/assistant"
        className="mt-4 flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--panel-2)]/60 px-3.5 py-2.5 text-xs font-medium text-zinc-300 hover:border-[var(--line-strong)] hover:text-white transition-colors group"
      >
        <span>Investigate fleet issues in Assistant</span>
        <ArrowUpRight className="size-3.5 text-[var(--accent)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
      </Link>
    </Card>
  );
}
