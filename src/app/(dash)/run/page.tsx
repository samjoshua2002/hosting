"use client";

import { Clock, Loader2, ScrollText, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useCluster } from "@/components/cluster";
import { PageHero } from "@/components/page-hero";
import { ScheduledTasks } from "@/components/scheduled-tasks";
import { Badge, Button, Card, SectionTitle, StatusDot, cx } from "@/components/ui";
import { useSearchParam, useStored } from "@/lib/client";
import { timeAgo, vmState } from "@/lib/format";
import { isDestructive } from "@/lib/safety";
import type { ExecResult, JobStartResult } from "@/lib/types";

const QUICK = [
  { label: "uptime", cmd: "hostname && uptime" },
  { label: "disk", cmd: "df -h ~ /" },
  { label: "memory", cmd: "free -h" },
  { label: "top", cmd: "ps aux --sort=-%cpu | head -n 8" },
  { label: "docker ps", cmd: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'" },
  { label: "versions", cmd: "node -v; npm -v; python3 -V; git --version; docker --version" },
  { label: "ports", cmd: "ss -ltnp | head -n 20" },
];

type Entry =
  | { id: number; kind: "exec"; targets: string[]; command: string; results: Record<string, ExecResult | "pending"> }
  | { id: number; kind: "job"; targets: string[]; command: string; jobs: JobStartResult[] | null }
  | { id: number; kind: "note"; targets: string[]; command: string; text: string; tone?: "error" | "dim" };

let nextId = 1;

export default function RunPage() {
  const { vms, status, checking, exec, startJobs, inflight, openJob, refresh } = useCluster();
  const vmParam = useSearchParam("vm");
  const cmdParam = useSearchParam("cmd");
  const [picked, setPicked] = useState<string[] | null>(null);
  const firstUp = vms.find((v) => status[v.name]?.ok)?.name ?? vms[0]?.name;
  const targets = picked ?? (vmParam ? [vmParam] : firstUp ? [firstUp] : []);
  const [typed, setTyped] = useState<string | null>(null);
  const input = typed ?? cmdParam ?? "";
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useStored<string[]>("hosting.history", []);
  const [cursor, setCursor] = useState(-1); // position in history while pressing ↑/↓
  const inputRef = useRef<HTMLInputElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  const names = vms.map((v) => v.name);
  const onlineNames = vms.filter((v) => status[v.name]?.ok).map((v) => v.name);
  const host = targets.length === 0 ? "?" : targets.length === 1 ? targets[0] : targets.length === names.length ? `all(${targets.length})` : `{${targets.join(",")}}`;

  useEffect(() => {
    screenRef.current?.scrollTo({ top: screenRef.current.scrollHeight });
  }, [entries]);

  const push = (e: Entry) => setEntries((list) => [...list, e].slice(-200));
  const toggle = (n: string) => setPicked(targets.includes(n) ? targets.filter((x) => x !== n) : [...targets, n]);

  const submit = async () => {
    const raw = input.trim();
    setTyped("");
    setCursor(-1);
    if (!raw) return push({ id: nextId++, kind: "note", targets, command: "", text: "" });
    setHistory([raw, ...history.filter((h) => h !== raw)].slice(0, 50));

    // built-ins
    if (raw === "clear") return setEntries([]);
    if (raw === "help")
      return push({
        id: nextId++,
        kind: "note",
        targets,
        command: raw,
        tone: "dim",
        text: "Runs on the machines in the prompt.\n  use box1 box2   pick machines   (use all · use online)\n  <cmd> &         run in the background, keeps going after you leave\n  clear           clear the screen   (Ctrl+L)\n  ↑ ↓             previous commands",
      });
    if (raw === "use" || raw.startsWith("use ")) {
      const args = raw.split(/\s+/).slice(1);
      const next = args.includes("all") ? names : args.includes("online") ? onlineNames : args.filter((a) => names.includes(a));
      const unknown = args.filter((a) => !["all", "online", ...names].includes(a));
      if (next.length) setPicked(next);
      return push({
        id: nextId++,
        kind: "note",
        targets,
        command: raw,
        tone: unknown.length || !next.length ? "error" : "dim",
        text: unknown.length ? `unknown machine: ${unknown.join(", ")} (have: ${names.join(", ")})` : next.length ? `now running on: ${next.join(", ")}` : "usage: use box1 box2 | use all | use online",
      });
    }
    if (!targets.length) return push({ id: nextId++, kind: "note", targets, command: raw, tone: "error", text: "no machine selected: type `use box1` or click one above" });

    const background = /\s&$/.test(raw);
    const command = background ? raw.replace(/\s*&$/, "") : raw;
    if (isDestructive(command) && !confirm(`This command can destroy data:\n\n${command}\n\nRun it on ${targets.join(", ")}?`)) {
      return push({ id: nextId++, kind: "note", targets, command: raw, tone: "dim", text: "cancelled" });
    }

    // machines that are resting (cooling down / unreachable) are skipped instead of failing loudly
    const resting = targets.filter((t) => status[t] && !status[t]!.ok && !checking[t]);
    const run = targets.filter((t) => !resting.includes(t));
    const skipped = () =>
      resting.length &&
      push({ id: nextId++, kind: "note", targets: resting, command: "", tone: "dim", text: `${resting.join(", ")} ${resting.length > 1 ? "are" : "is"} resting right now (cooling down), skipped${run.length ? "" : ". Try again in a few minutes"}` });
    if (!run.length) {
      push({ id: nextId++, kind: "note", targets, command: raw, tone: "dim", text: "" });
      return void skipped();
    }
    const id = nextId++;
    if (background) {
      push({ id, kind: "job", targets: run, command: raw, jobs: null });
      skipped();
      try {
        const jobs = await startJobs(run, command);
        setEntries((list) => list.map((e) => (e.id === id && e.kind === "job" ? { ...e, jobs } : e)));
      } catch (err) {
        setEntries((list) => list.map((e) => (e.id === id ? { id, kind: "note", targets: run, command: raw, tone: "error", text: (err as Error).message } : e)));
      }
      return;
    }
    push({ id, kind: "exec", targets: run, command: raw, results: Object.fromEntries(run.map((t) => [t, "pending" as const])) });
    skipped();
    await exec(run, command, (r) =>
      setEntries((list) => list.map((e) => (e.id === id && e.kind === "exec" ? { ...e, results: { ...e.results, [r.vm]: r } } : e))),
    );
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const c = Math.min(cursor + 1, history.length - 1);
      if (c >= 0) {
        setCursor(c);
        setTyped(history[c]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const c = cursor - 1;
      setCursor(Math.max(c, -1));
      setTyped(c >= 0 ? history[c] : "");
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    }
  };

  const jobs = useMemo(
    () =>
      vms
        .flatMap((v) => (status[v.name]?.agent?.jobs ?? []).map((j) => ({ ...j, vm: v.name })))
        .sort((a, b) => b.meta.startedAt - a.meta.startedAt)
        .slice(0, 30),
    [vms, status],
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
      <PageHero
        eyebrow="Remote shell"
        title="Run"
        icon={<SquareTerminal className="size-6" />}
        desc="A shell on one machine or many at once. End a command with & to run it in the background."
      />

      {/* the terminal */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[hsl(var(--h)_30%_4%)] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
          <span className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-2.5 rounded-full bg-white/15" />
            ))}
          </span>
          <span className="font-mono text-xs text-muted">user@{host} — ssh</span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {vms.map((v) => {
              const on = targets.includes(v.name);
              return (
                <button
                  key={v.name}
                  onClick={() => toggle(v.name)}
                  className={cx(
                    "flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors",
                    on ? "bg-accent/20 text-ink ring-1 ring-accent/50" : "text-muted hover:bg-white/5 hover:text-white",
                  )}
                  title={on ? "Remove from this shell" : "Add to this shell"}
                >
                  <StatusDot state={vmState(status[v.name], Boolean(checking[v.name]))} />
                  {v.name}
                  {inflight[v.name] && <Loader2 className="size-3 animate-spin" />}
                </button>
              );
            })}
            <button onClick={() => setPicked(onlineNames)} className="rounded-md px-2 py-0.5 font-mono text-[11px] text-muted hover:bg-white/5 hover:text-white">
              all
            </button>
          </div>
        </div>

        <div
          ref={screenRef}
          onClick={() => {
            if (!window.getSelection()?.toString()) inputRef.current?.focus();
          }}
          className="scroll-thin h-[58vh] min-h-[420px] cursor-text overflow-y-auto px-5 py-4 font-mono text-[13px] leading-relaxed text-zinc-200"
        >
          <p className="text-muted">
            Connected to {onlineNames.length} of {names.length} machines. Type <span className="text-ink">help</span> for shortcuts.
          </p>

          {entries.map((e) => (
            <div key={e.id} className="mt-2">
              {!(e.kind === "note" && !e.command && e.text) && <Prompt host={e.targets.length === 1 ? e.targets[0] : e.targets.length === names.length ? `all(${e.targets.length})` : `{${e.targets.join(",")}}`} />}
              <span className="break-all whitespace-pre-wrap text-white">{e.command}</span>
              {e.kind === "note" && e.text && (
                <pre className={cx("whitespace-pre-wrap", e.tone === "error" ? "text-[var(--critical-text)]" : "text-muted")}>{e.text}</pre>
              )}
              {e.kind === "job" &&
                (e.jobs === null ? (
                  <p className="text-muted">starting…</p>
                ) : (
                  e.jobs.map((j) =>
                    j.error ? (
                      <p key={j.vm} className="text-[var(--critical-text)]">
                        [{j.vm}] {j.error}
                      </p>
                    ) : (
                      <p key={j.vm} className="text-muted">
                        [{j.vm}] running in background as {j.id} ·{" "}
                        <button onClick={() => openJob({ vm: j.vm, id: j.id!, title: e.command })} className="text-accent-soft underline underline-offset-2">
                          follow log
                        </button>
                      </p>
                    ),
                  )
                ))}
              {e.kind === "exec" &&
                e.targets.map((t) => {
                  const r = e.results[t];
                  return (
                    <div key={t}>
                      {e.targets.length > 1 && (
                        <p className="mt-1 text-muted">
                          ── {t}
                          {r !== "pending" && ` · ${r.code === null ? "error" : `exit ${r.code}`} · ${(r.ms / 1000).toFixed(1)}s`} ──
                        </p>
                      )}
                      {r === "pending" ? (
                        <p className="flex items-center gap-2 text-muted">
                          <Loader2 className="size-3 animate-spin" /> running on {t}…
                        </p>
                      ) : (
                        <>
                          {r.stdout && <pre className="break-all whitespace-pre-wrap">{r.stdout.replace(/\n$/, "")}</pre>}
                          {r.stderr && <pre className="break-all whitespace-pre-wrap text-[var(--critical-text)]">{r.stderr.replace(/\n$/, "")}</pre>}
                          {r.error && <p className="text-[var(--critical-text)]">{r.error}</p>}
                          {r.truncated && <p className="text-muted">… output cut at 256 KB</p>}
                          {e.targets.length === 1 && r.code !== 0 && r.code !== null && <p className="text-[var(--critical-text)]">[exit {r.code}]</p>}
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}

          <div className="mt-2 flex items-baseline">
            <Prompt host={host} />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setTyped(e.target.value);
                setCursor(-1);
              }}
              onKeyDown={onKey}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-label="Command"
              className="min-w-0 flex-1 bg-transparent p-0 font-mono text-[13px] text-white caret-[var(--accent)] outline-none"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted">Quick commands</span>
        {QUICK.map((q) => (
          <button
            key={q.label}
            onClick={() => {
              setTyped(q.cmd);
              inputRef.current?.focus();
            }}
            className="rounded-full border border-white/10 px-2.5 py-0.5 font-mono text-[11px] text-muted hover:border-accent/50 hover:text-white"
          >
            {q.label}
          </button>
        ))}
      </div>

      <ScheduledTasks />

      <section>
        <SectionTitle
          right={
            <Button size="sm" variant="ghost" onClick={() => refresh()}>
              Refresh
            </Button>
          }
        >
          Background jobs
        </SectionTitle>
        <Card className="overflow-hidden">
          {jobs.length === 0 ? (
            <p className="p-4 text-sm text-muted">
              None yet. End a command with <code className="text-ink">&amp;</code> to run it in the background.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.06] text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Machine</th>
                  <th className="px-4 py-2 font-medium">Command</th>
                  <th className="px-4 py-2 font-medium">State</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {jobs.map((j) => (
                  <tr key={`${j.vm}-${j.id}`} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2 font-mono text-ink">{j.vm}</td>
                    <td className="max-w-[420px] truncate px-4 py-2 font-mono text-muted">{j.meta.label}</td>
                    <td className="px-4 py-2">
                      {j.state === "running" ? (
                        <Badge tone="amber">
                          <Clock className="size-3" /> running
                        </Badge>
                      ) : j.state === "done" ? (
                        <Badge tone={j.exitCode === 0 ? "green" : "red"}>exit {j.exitCode}</Badge>
                      ) : (
                        <Badge>stopped</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted">{timeAgo(j.meta.startedAt * 1000)}</td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openJob({ vm: j.vm, id: j.id, title: j.meta.label })}>
                        <ScrollText className="size-3.5" /> Log
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}

function Prompt({ host }: { host: string }) {
  return (
    <span className="mr-2 shrink-0 select-none">
      <span className="text-accent">user@{host}</span>
      <span className="text-white/40">:</span>
      <span className="text-accent-soft">~</span>
      <span className="text-white/60">$</span>
    </span>
  );
}
