"use client";

import { CalendarClock, Play, Plus, ScrollText, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { vmState } from "@/lib/format";
import { useCluster } from "./cluster";
import { Drawer } from "./drawer";
import { Badge, Button, Card, Field, Output, SectionTitle, StatusDot, cx, inputCls } from "./ui";

const PRESETS = [
  { label: "every 5 min", cron: "*/5 * * * *" },
  { label: "every 20 min", cron: "*/20 * * * *" },
  { label: "hourly", cron: "0 * * * *" },
  { label: "daily 03:00", cron: "0 3 * * *" },
  { label: "weekly Mon 09:00", cron: "0 9 * * 1" },
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Plain-words cron for the common shapes (UTC on the machines); falls back to the raw expression. */
export function cronText(s: string): string {
  const special: Record<string, string> = { "@hourly": "every hour", "@daily": "every day at 00:00", "@midnight": "every day at 00:00", "@weekly": "every Sunday at 00:00", "@monthly": "on the 1st of each month", "@reboot": "at every boot" };
  if (special[s]) return special[s];
  const f = s.split(/\s+/);
  if (f.length !== 5) return s;
  const [m, h, dom, mon, dow] = f;
  const pad = (x: string) => x.padStart(2, "0");
  if (/^\*\/\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${m.slice(2)} min`;
  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "every minute";
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return m === "0" ? "every hour" : `hourly at :${pad(m)}`;
  if (/^\d+$/.test(m) && /^\*\/\d+$/.test(h) && dom === "*" && mon === "*" && dow === "*") return `every ${h.slice(2)} h at :${pad(m)}`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && dow === "*") return `daily at ${pad(h)}:${pad(m)} UTC`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && /^[0-7]$/.test(dow)) return `${DAYS[Number(dow)]}s at ${pad(h)}:${pad(m)} UTC`;
  return s;
}

export function ScheduledTasks() {
  const { vms, status, checking, refresh } = useCluster();
  const [form, setForm] = useState<{ name: string; schedule: string; command: string; targets: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(
    () => vms.flatMap((v) => (status[v.name]?.agent?.cron ?? []).map((c, i) => ({ ...c, vm: v.name, key: `${v.name}-${c.name || i}` }))),
    [vms, status],
  );

  const call = async (action: "add" | "remove" | "run" | "logs", vmsList: string[], name: string, extra: Record<string, string> = {}) => {
    const r = await api<{ results: { vm: string; ok: boolean; output: string }[] }>("/api/cron", { action, vms: vmsList, name, ...extra });
    return r.results;
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const res = await call("add", form.targets, form.name, { schedule: form.schedule, command: form.command });
      const bad = res.filter((r) => !r.ok);
      if (bad.length) throw new Error(bad.map((r) => `${r.vm}: ${r.output}`).join("\n"));
      setForm(null);
      await refresh(form.targets);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const act = async (row: (typeof rows)[number], action: "run" | "logs" | "remove") => {
    if (action === "remove" && !confirm(`Remove the scheduled task ${row.name} from ${row.vm}?`)) return;
    setBusy(`${row.key}:${action}`);
    try {
      const [r] = await call(action, [row.vm], row.name);
      if (action === "remove") await refresh([row.vm]);
      else setView({ title: `${row.name} on ${row.vm}${action === "run" ? " · ran now" : " · recent runs"}`, text: r.output });
    } catch (e) {
      setView({ title: "Error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <SectionTitle
        right={
          <Button size="sm" onClick={() => setForm({ name: "", schedule: "*/20 * * * *", command: "", targets: vms[0] ? [vms[0].name] : [] })}>
            <Plus className="size-3.5" /> New task
          </Button>
        }
      >
        Scheduled tasks
      </SectionTitle>
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">
            No scheduled tasks. Add one here or ask the Assistant (&quot;ping my API every 20 minutes&quot;). Paused machines skip runs until they wake.
          </p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="border-b border-white/[0.06] text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Machine</th>
                <th className="px-4 py-2 font-medium">Task</th>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Command</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {rows.map((r) => (
                <tr key={r.key} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2 font-mono text-ink">{r.vm}</td>
                  <td className="px-4 py-2">{r.name ? <span className="font-medium text-white">{r.name}</span> : <Badge>added by hand</Badge>}</td>
                  <td className="px-4 py-2 text-ink" title={r.schedule}>
                    <span className="flex items-center gap-1.5">
                      <CalendarClock className="size-3.5 text-muted" /> {cronText(r.schedule)}
                    </span>
                  </td>
                  <td className="max-w-[380px] truncate px-4 py-2 font-mono text-muted" title={r.command}>
                    {r.command}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {r.name && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => act(r, "run")} loading={busy === `${r.key}:run`}>
                          <Play className="size-3.5" /> Run now
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => act(r, "logs")} loading={busy === `${r.key}:logs`}>
                          <ScrollText className="size-3.5" /> Logs
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => act(r, "remove")} loading={busy === `${r.key}:remove`} className="hover:text-[var(--critical-text)]">
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {form && (
        <Drawer title="New scheduled task" subtitle="Runs on each selected machine on its own schedule (machine time is UTC)." onClose={() => setForm(null)}>
          <div className="space-y-4">
            <Field label="Name" hint="lowercase, digits, dashes">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} className={inputCls} placeholder="api-heartbeat" />
            </Field>
            <Field label="When" hint={<>{cronText(form.schedule)} · 5 cron fields: minute hour day month weekday</>}>
              <input value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} className={cx(inputCls, "font-mono")} />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.cron} onClick={() => setForm({ ...form, schedule: p.cron })} className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-ink hover:border-accent/60">
                  {p.label}
                </button>
              ))}
            </div>
            <Field label="Command" hint="Bash, runs in your home folder. Output goes to the task's log.">
              <textarea value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} rows={5} spellCheck={false} className={cx(inputCls, "font-mono text-xs")} placeholder="curl -fsS https://… >/dev/null" />
            </Field>
            <Field label="Machines">
              <div className="flex flex-wrap gap-1.5">
                {vms.map((v) => {
                  const on = form.targets.includes(v.name);
                  return (
                    <button
                      key={v.name}
                      onClick={() => setForm({ ...form, targets: on ? form.targets.filter((t) => t !== v.name) : [...form.targets, v.name] })}
                      className={cx("flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs", on ? "border-accent/70 bg-accent/15 text-ink" : "border-line-strong text-muted")}
                    >
                      <StatusDot state={vmState(status[v.name], Boolean(checking[v.name]))} /> {v.name}
                    </button>
                  );
                })}
              </div>
            </Field>
            {error && <pre className="text-sm whitespace-pre-wrap text-[var(--critical-text)]">{error}</pre>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} loading={saving} disabled={!form.name || !form.command.trim() || !form.targets.length}>
                Schedule on {form.targets.length} machine{form.targets.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </Drawer>
      )}
      {view && (
        <Drawer title={view.title} onClose={() => setView(null)}>
          <Output text={view.text || "(no output)"} className="max-h-none" />
        </Drawer>
      )}
    </section>
  );
}
