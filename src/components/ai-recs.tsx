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
      <div className="flex items-center justify-between">
        <h2 className="text-[17px] font-semibold text-white">Suggestions</h2>
        <button
          onClick={() => void load()}
          disabled={busy || !ready}
          className="rounded-full p-1.5 text-muted hover:bg-white/5 hover:text-white disabled:opacity-40"
          aria-label="Refresh suggestions"
        >
          <RefreshCw className={cx("size-3.5", busy && "animate-spin")} />
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-[var(--critical-text)]">{error}</p>}
      {!data && !error && <p className="mt-3 text-sm text-muted">{ready ? "Looking at your machines…" : "Waiting for machines to report…"}</p>}
      {data && (
        <ul className={cx("mt-3 flex-1 divide-y divide-white/[0.06]", busy && "opacity-60")}>
          {data.recs.map((r) => (
            <li key={r.title} className="py-3 first:pt-1">
              <p className="flex items-start gap-2 text-sm font-medium text-white">
                <span
                  className={cx(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    r.severity === "critical" ? "bg-[var(--critical)]" : r.severity === "warning" ? "bg-[var(--warning)]" : "bg-accent",
                  )}
                />
                {r.title}
              </p>
              <p className="mt-0.5 pl-3.5 text-xs text-muted">{r.detail}</p>
              {r.command && (
                <Link
                  href={`/run?${new URLSearchParams({ ...(r.vm ? { vm: r.vm } : {}), cmd: r.command })}`}
                  className="mt-1.5 ml-3.5 inline-flex max-w-[calc(100%-0.875rem)] items-center gap-1.5 rounded-md bg-black/30 px-2 py-1 font-mono text-[11px] text-ink hover:bg-black/50"
                  title="Opens in Run; nothing runs until you press Run"
                >
                  <span className="truncate">$ {r.command}</span>
                  <ArrowUpRight className="size-3 shrink-0" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link href="/assistant" className="mt-3 flex items-center gap-1 text-xs font-semibold text-accent-soft hover:text-white">
        Ask a question about your servers <ArrowUpRight className="size-3.5" />
      </Link>
    </Card>
  );
}
