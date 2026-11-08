"use client";

import { Check, ChevronDown, Loader2, Square, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { JobLog } from "@/lib/types";
import { Drawer } from "./drawer";
import { Badge, Button, cx } from "./ui";

const STEPS = ["Getting ready", "Getting the code", "Installing and building", "Starting", "Creating the link", "Ready"];

/** Where a deploy is, from the markers hostctl prints. */
function deployStep(log: string): number {
  if (/==> done/.test(log)) return 5;
  if (/==> publishing port/.test(log)) return 4;
  if (/==> \(re\)starting service/.test(log)) return 3;
  const marks = log.split("\n").filter((l) => l.startsWith("==> ") && !/deploying|git (clone|fetch)|static export/.test(l));
  if (marks.length) return 2;
  if (/==> git (clone|fetch)/.test(log)) return 1;
  return 0;
}

export function JobDrawer({ job, onClose }: { job: { vm: string; id: string; title: string }; onClose: () => void }) {
  const [data, setData] = useState<JobLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await api<JobLog>(`/api/jobs/log?vm=${encodeURIComponent(job.vm)}&id=${encodeURIComponent(job.id)}`);
      setData(d);
      setError(null);
      return d.state;
    } catch (e) {
      setError((e as Error).message);
      return "lost";
    }
  }, [job.vm, job.id]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const state = await load();
      if (alive && state === "running") timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [data?.log]);

  const stop = async () => {
    setStopping(true);
    try {
      await api("/api/jobs/kill", { vm: job.vm, id: job.id });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const state = data?.state;
  const deploy = /^(deploy|install) /.test(job.title);
  const project = deploy ? job.title.replace(/^(deploy|install) /, "").split(" ")[0] : null;
  const step = data ? deployStep(data.log) : 0;
  const failed = state === "done" && data?.exitCode !== 0;
  const finished = state === "done" && data?.exitCode === 0;
  const [showLog, setShowLog] = useState(false);
  const tail = (data?.log ?? "").trim().split("\n").slice(-8).join("\n");
  return (
    <Drawer
      title={job.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{job.vm}</span>
          <span className="font-mono text-zinc-600">{job.id}</span>
          {state === "running" && <Badge tone="amber">running</Badge>}
          {state === "done" && <Badge tone={data?.exitCode === 0 ? "green" : "red"}>exit {data?.exitCode ?? "?"}</Badge>}
          {state === "lost" && <Badge tone="gray">stopped / lost</Badge>}
        </span>
      }
      actions={
        state === "running" && (
          <Button size="sm" variant="danger" onClick={stop} loading={stopping}>
            <Square className="size-3" /> Stop
          </Button>
        )
      }
      onClose={onClose}
    >
      {error && <p className="mb-3 text-sm text-rose-300">{error}</p>}
      {deploy && (
        <div className="mb-5 space-y-5">
          <ol className="space-y-0">
            {STEPS.map((label, i) => {
              const done = finished || i < step;
              const current = !finished && !failed && i === step;
              const broke = failed && i === step;
              return (
                <li key={label} className="flex items-center gap-3 py-1.5">
                  <span
                    className={cx(
                      "grid size-7 shrink-0 place-items-center rounded-full border text-xs",
                      done ? "border-accent bg-accent/20 text-ink" : broke ? "border-[var(--critical)] bg-[var(--critical)]/15 text-[var(--critical-text)]" : current ? "border-accent/60 text-ink" : "border-line-strong text-muted",
                    )}
                  >
                    {done ? <Check className="size-3.5" /> : broke ? <X className="size-3.5" /> : current ? <Loader2 className="size-3.5 animate-spin" /> : i + 1}
                  </span>
                  <span className={cx("text-sm", done || current ? "text-white" : broke ? "text-[var(--critical-text)]" : "text-muted")}>{label}</span>
                </li>
              );
            })}
          </ol>
          {failed && (
            <div className="rounded-xl border border-[var(--critical)]/40 bg-[var(--critical)]/10 p-3">
              <p className="mb-2 text-sm font-medium text-white">It stopped at “{STEPS[step]}”. The last lines say:</p>
              <pre className="overflow-x-auto font-mono text-[11.5px] whitespace-pre-wrap text-[var(--critical-text)]">{tail}</pre>
              <p className="mt-2 text-xs text-muted">Ask the Assistant “fix the deploy of {project}”: it reads this log, fixes the commands and redeploys.</p>
            </div>
          )}
          {finished && project && (
            <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 p-3">
              <Check className="size-4 text-accent-soft" />
              <p className="flex-1 text-sm text-white">{project} is live.</p>
              <Link href={`/projects/${project}`} onClick={onClose} className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-[#0b0e1c] hover:bg-white/90">
                View project
              </Link>
            </div>
          )}
          <button onClick={() => setShowLog((v) => !v)} className="flex items-center gap-1.5 text-xs text-muted hover:text-white">
            <ChevronDown className={cx("size-3.5 transition-transform", !showLog && "-rotate-90")} /> {showLog ? "Hide" : "Show"} the full log
          </button>
        </div>
      )}
      {(!deploy || showLog) && (
      <pre
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={cx(
          "scroll-thin overflow-auto rounded-md bg-black/60 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-zinc-300",
          deploy ? "h-[50dvh]" : "h-[calc(100dvh-9rem)]",
        )}
      >
        {data ? data.log || "(no output yet)" : "Loading…"}
      </pre>
      )}
    </Drawer>
  );
}
