"use client";

import { Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { JobLog } from "@/lib/types";
import { Drawer } from "./drawer";
import { Badge, Button } from "./ui";

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
      <pre
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="scroll-thin h-[calc(100dvh-9rem)] overflow-auto rounded-md bg-black/60 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-zinc-300"
      >
        {data ? data.log || "(no output yet)" : "Loading…"}
      </pre>
    </Drawer>
  );
}
