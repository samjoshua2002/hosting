"use client";

import { CheckCircle2, Clock, Loader2, Play, ScrollText, SquareTerminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useCluster } from "@/components/cluster";
import { PageHero } from "@/components/page-hero";
import { Badge, Button, Card, Output, SectionTitle, StatusDot, cx, inputCls } from "@/components/ui";
import { useSearchParam, useStored } from "@/lib/client";
import { timeAgo, vmState } from "@/lib/format";
import { isDestructive } from "@/lib/safety";
import type { ExecResult } from "@/lib/types";

const SNIPPETS = [
  { label: "uptime", cmd: "hostname && uptime" },
  { label: "disk", cmd: "df -h ~ /" },
  { label: "memory", cmd: "free -h" },
  { label: "top processes", cmd: "ps aux --sort=-%cpu | head -n 8" },
  { label: "docker ps", cmd: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'" },
  { label: "versions", cmd: "node -v; npm -v; python3 -V; git --version; docker --version" },
  { label: "listening ports", cmd: "ss -ltnp | head -n 20" },
];

export default function RunPage() {
  const { vms, status, checking, exec, startJobs, inflight, openJob, refresh } = useCluster();
  const vmParam = useSearchParam("vm");
  const [picked, setSelected] = useState<string[] | null>(null);
  const selected = picked ?? (vmParam ? [vmParam] : []);
  const cmdParam = useSearchParam("cmd");
  const [typed, setCommand] = useState<string | null>(null);
  const command = typed ?? cmdParam ?? "";
  const [background, setBackground] = useState(false);
  const [runResults, setRunResults] = useState<Record<string, ExecResult | "pending">>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useStored<string[]>("hosting.history", []);

  const onlineNames = vms.filter((v) => status[v.name]?.ok).map((v) => v.name);
  const toggle = (n: string) => setSelected(selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n]);

  const leastBusy = () => {
    const best = vms
      .filter((v) => status[v.name]?.ok)
      .map((v) => ({ n: v.name, load: status[v.name]!.agent!.load[0] / status[v.name]!.agent!.cores }))
      .sort((a, b) => a.load - b.load)[0];
    if (best) setSelected([best.n]);
  };

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || !selected.length) return;
    if (isDestructive(cmd) && !confirm(`This command can destroy data:\n\n${cmd}\n\nRun it on ${selected.join(", ")}?`)) return;
    setError(null);
    setRunning(true);
    const nextHistory = [cmd, ...history.filter((h) => h !== cmd)].slice(0, 30);
    setHistory(nextHistory);
    try {
      if (background) {
        const jobs = await startJobs(selected, cmd);
        setRunResults({});
        const first = jobs.find((j) => j.id);
        if (first?.id) openJob({ vm: first.vm, id: first.id, title: cmd.split("\n")[0].slice(0, 80) });
        const failed = jobs.filter((j) => j.error);
        if (failed.length) setError(failed.map((j) => `${j.vm}: ${j.error}`).join("\n"));
      } else {
        setRunResults(Object.fromEntries(selected.map((s) => [s, "pending" as const])));
        await exec(selected, cmd, (r) => setRunResults((p) => ({ ...p, [r.vm]: r })));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
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
    <div className="mx-auto max-w-7xl space-y-6 px-8 py-6">
      <PageHero
        eyebrow="Remote shell"
        title="Run"
        icon={<SquareTerminal className="size-6" />}
        desc="Send a command to one machine or many. Output streams back here; long installs and builds are better as background jobs that keep running after you leave."
      />

      <Card className="space-y-4 p-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">Targets</span>
            <Button size="sm" onClick={() => setSelected(onlineNames)}>
              All online ({onlineNames.length})
            </Button>
            <Button size="sm" onClick={() => setSelected(vms.map((v) => v.name))}>
              All ({vms.length})
            </Button>
            <Button size="sm" onClick={leastBusy}>
              Least busy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {vms.map((v) => {
              const on = selected.includes(v.name);
              return (
                <button
                  key={v.name}
                  onClick={() => toggle(v.name)}
                  className={cx(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                    on ? "border-[var(--accent)]/70 bg-[var(--accent)]/15 text-ink" : "border-[var(--line-strong)] text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  <StatusDot state={vmState(status[v.name], Boolean(checking[v.name]))} />
                  {v.name}
                  {inflight[v.name] && <Loader2 className="size-3 animate-spin text-amber-300" />}
                </button>
              );
            })}
          </div>
        </div>

        <textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
          }}
          rows={4}
          spellCheck={false}
          placeholder="e.g. docker ps   (⌘/Ctrl + Enter to run)"
          className={cx(inputCls, "font-mono text-[13px]")}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {SNIPPETS.map((s) => (
              <button
                key={s.label}
                onClick={() => setCommand(s.cmd)}
                className="rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-300 select-none">
              <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} className="accent-[var(--accent)]" />
              Run in background
            </label>
            <Button variant="primary" onClick={run} loading={running} disabled={!command.trim() || !selected.length}>
              <Play className="size-3.5" />
              Run on {selected.length || "…"}
            </Button>
          </div>
        </div>
        {error && <pre className="rounded-md bg-rose-950/30 p-3 text-xs whitespace-pre-wrap text-rose-300">{error}</pre>}
      </Card>

      {Object.keys(runResults).length > 0 && (
        <section>
          <SectionTitle>Output</SectionTitle>
          <div className="grid gap-3 lg:grid-cols-2">
            {Object.entries(runResults).map(([vm, r]) => (
              <Card key={vm} className="p-3">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono font-semibold">{vm}</span>
                  {r === "pending" ? (
                    <span className="flex items-center gap-1 text-amber-300">
                      <Loader2 className="size-3 animate-spin" /> running
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="text-zinc-500">{(r.ms / 1000).toFixed(1)}s</span>
                      {r.code === 0 ? (
                        <Badge tone="green">
                          <CheckCircle2 className="size-3" /> exit 0
                        </Badge>
                      ) : (
                        <Badge tone="red">
                          <XCircle className="size-3" /> {r.code === null ? "failed" : `exit ${r.code}`}
                        </Badge>
                      )}
                    </span>
                  )}
                </div>
                {r !== "pending" && (
                  <div className="space-y-2">
                    {r.error && <p className="text-xs text-rose-300">{r.error}</p>}
                    <Output text={r.stdout} />
                    <Output text={r.stderr} tone="err" />
                    {!r.stdout && !r.stderr && !r.error && <p className="text-xs text-zinc-600">(no output)</p>}
                    {r.truncated && <p className="text-[11px] text-amber-300">Output truncated at 256 KB.</p>}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
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
              <p className="p-4 text-sm text-zinc-500">No jobs yet. Tick &quot;Run in background&quot; to start one.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[var(--line)] text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">VM</th>
                    <th className="px-3 py-2 font-medium">Job</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">Started</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {jobs.map((j) => (
                    <tr key={`${j.vm}-${j.id}`} className="hover:bg-zinc-900/50">
                      <td className="px-3 py-2 font-mono text-zinc-300">{j.vm}</td>
                      <td className="max-w-[260px] truncate px-3 py-2 font-mono text-zinc-400">{j.meta.label}</td>
                      <td className="px-3 py-2">
                        {j.state === "running" ? (
                          <Badge tone="amber">
                            <Clock className="size-3" /> running
                          </Badge>
                        ) : j.state === "done" ? (
                          <Badge tone={j.exitCode === 0 ? "green" : "red"}>exit {j.exitCode}</Badge>
                        ) : (
                          <Badge>lost</Badge>
                        )}
                      </td>
                      <td className="hidden px-3 py-2 text-zinc-500 sm:table-cell">{timeAgo(j.meta.startedAt * 1000)}</td>
                      <td className="px-3 py-2 text-right">
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
        <section>
          <SectionTitle>History</SectionTitle>
          <Card className="scroll-thin max-h-96 overflow-auto">
            {history.length === 0 ? (
              <p className="p-4 text-sm text-zinc-500">Commands you run appear here.</p>
            ) : (
              <ul className="divide-y divide-[var(--line)]">
                {history.map((h) => (
                  <li key={h}>
                    <button
                      onClick={() => setCommand(h)}
                      className="block w-full truncate px-3 py-2 text-left font-mono text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                    >
                      {h}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
