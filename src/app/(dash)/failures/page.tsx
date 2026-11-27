"use client";

import { AlertTriangle, Check, ChevronDown, ChevronRight, Download, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHero } from "@/components/page-hero";
import { Badge, Button, Card, Empty, Output, SectionTitle, cx } from "@/components/ui";
import { api } from "@/lib/client";

interface Failure {
  id: string;
  at: number;
  kind: string;
  sessionId?: string;
  model?: string;
  tool?: string;
  label?: string;
  args?: string;
  error: string;
  count?: number;
  plan?: string;
  resolved?: boolean;
}

/** What each kind means, in plain words. */
const KIND: Record<string, { label: string; tone: "red" | "amber" | "gray" }> = {
  tool_failed: { label: "Action failed", tone: "red" },
  tool_crashed: { label: "Action crashed", tone: "red" },
  stuck_loop: { label: "Stuck in a loop", tone: "red" },
  model_error: { label: "Model error", tone: "amber" },
  run_crashed: { label: "Run crashed", tone: "red" },
  round_limit: { label: "Ran out of rounds", tone: "amber" },
  time_budget: { label: "Ran out of time", tone: "amber" },
  plan_step_failed: { label: "Plan step failed", tone: "amber" },
  unfinished_plan: { label: "Left unfinished", tone: "amber" },
};
const kindOf = (k: string) => KIND[k] ?? { label: k, tone: "gray" as const };

const when = (t: number) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Save text as a file in the browser. */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(items: Failure[]): string {
  const cols: (keyof Failure | "time")[] = ["time", "kind", "tool", "label", "error", "args", "count", "plan", "sessionId", "model", "resolved", "id"];
  const rows = items.map((f) => cols.map((c) => csvCell(c === "time" ? new Date(f.at).toISOString() : c === "kind" ? kindOf(f.kind).label : f[c])).join(","));
  return [cols.join(","), ...rows].join("\n");
}

export default function FailuresPage() {
  const [items, setItems] = useState<Failure[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState<"open" | "all" | "resolved">("open");
  const [kind, setKind] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);

  const fetchItems = useCallback(
    () =>
      api<{ items: Failure[] }>("/api/assistant/failures")
        .then((d) => {
          setItems(d.items);
          setError(null);
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  const load = useCallback(async () => {
    setBusy(true);
    await fetchItems();
    setBusy(false);
  }, [fetchItems]);
  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const visible = useMemo(
    () => (items ?? []).filter((f) => (show === "all" || (show === "open" ? !f.resolved : f.resolved)) && (!kind || f.kind === kind)),
    [items, show, kind],
  );

  // the tools that fail most, so the worst spot is obvious
  const top = useMemo(() => {
    const n = new Map<string, number>();
    for (const f of items ?? []) if (!f.resolved && f.tool) n.set(f.tool, (n.get(f.tool) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [items]);

  const counts = useMemo(() => {
    const n = new Map<string, number>();
    for (const f of items ?? []) if (!f.resolved) n.set(f.kind, (n.get(f.kind) ?? 0) + 1);
    return n;
  }, [items]);

  const mark = async (ids: string[], resolved: boolean) => {
    setItems((list) => list?.map((f) => (ids.includes(f.id) ? { ...f, resolved } : f)) ?? null);
    await api("/api/assistant/failures", { ids, resolved }).catch((e) => setError((e as Error).message));
  };
  const remove = async (body: { ids: string[] } | { resolved: true }) => {
    await api("/api/assistant/failures", body, { method: "DELETE" }).catch((e) => setError((e as Error).message));
    void load();
  };

  const exportAll = (fmt: "json" | "csv") => {
    const stamp = new Date().toISOString().slice(0, 10);
    const all = items ?? [];
    if (fmt === "json") download(`assistant-failures-${stamp}.json`, JSON.stringify(all, null, 2), "application/json");
    else download(`assistant-failures-${stamp}.csv`, toCsv(all), "text/csv");
  };

  const openCount = (items ?? []).filter((f) => !f.resolved).length;

  return (
    <div className="space-y-5">
      <PageHero
        eyebrow="Assistant"
        title="Failure log"
        icon={<AlertTriangle className="size-6" />}
        desc="Every place the Assistant failed or got stuck: the action, its arguments and the exact error. Only failures are kept, for 90 days."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => exportAll("csv")} disabled={!items?.length}>
              <Download className="size-3.5" /> Export CSV
            </Button>
            <Button size="sm" onClick={() => exportAll("json")} disabled={!items?.length}>
              <Download className="size-3.5" /> Export JSON
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void load()} loading={busy}>
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          </div>
        }
      />
      {error && <p className="rounded-lg bg-rose-950/40 p-3 text-sm text-rose-300">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="p-5">
          <SectionTitle
            right={
              <div className="flex flex-wrap items-center gap-2">
                <select className="h-7 rounded-md border border-[var(--line-strong)] bg-[var(--panel-2)] px-2 text-xs" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
                  <option value="">All kinds</option>
                  {Object.entries(KIND).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <div className="flex rounded-md border border-[var(--line-strong)] p-0.5 text-xs" role="tablist">
                  {(["open", "resolved", "all"] as const).map((s) => (
                    <button key={s} type="button" role="tab" aria-selected={show === s} onClick={() => setShow(s)} className={cx("rounded px-2 py-0.5 capitalize", show === s ? "bg-white/10 text-ink" : "text-muted hover:text-ink")}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            }
          >
            {show === "open" ? `${openCount} open` : show === "resolved" ? "Fixed" : "All failures"}
          </SectionTitle>

          {items === null ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-white/[0.04]" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <Empty icon={<Check className="size-8" />} title={show === "open" ? "Nothing failing" : "No entries"}>
              {show === "open" ? "When the Assistant fails or gets stuck, it shows up here with the exact error." : "Try another filter."}
            </Empty>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {visible.map((f) => {
                const k = kindOf(f.kind);
                const expanded = open === f.id;
                return (
                  <li key={f.id} className={cx("py-2.5", f.resolved && "opacity-60")}>
                    <div className="flex items-start gap-3">
                      <button type="button" onClick={() => setOpen(expanded ? null : f.id)} className="mt-0.5 text-muted hover:text-ink" aria-label={expanded ? "Hide details" : "Show details"}>
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={k.tone}>{k.label}</Badge>
                          {f.count ? <Badge tone="red">×{f.count}</Badge> : null}
                          <span className="truncate text-sm font-medium text-ink">{f.label || f.tool || "Assistant run"}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted">{when(f.at)}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted">{f.error}</p>
                        {expanded && (
                          <div className="mt-3 space-y-2 text-xs">
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
                              {f.tool && <span>Tool: <b className="text-ink">{f.tool}</b></span>}
                              {f.plan && <span>Plan: <b className="text-ink">{f.plan}</b></span>}
                              {f.model && <span>Model: <b className="text-ink">{f.model}</b></span>}
                              {f.sessionId && <span>Session: <code className="text-ink">{f.sessionId}</code></span>}
                            </div>
                            <Output text={f.error} tone="err" />
                            {f.args && f.args !== "{}" && <Output text={f.args} />}
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => void mark([f.id], !f.resolved)}>
                                {f.resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />} {f.resolved ? "Reopen" : "Mark fixed"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => void remove({ ids: [f.id] })}>
                                <Trash2 className="size-3.5" /> Delete
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          <Card className="p-5">
            <SectionTitle>Open by kind</SectionTitle>
            {counts.size === 0 ? (
              <p className="text-sm text-muted">None open.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                  <li key={k}>
                    <button type="button" onClick={() => setKind(kind === k ? "" : k)} className={cx("flex w-full justify-between rounded px-1.5 py-0.5 hover:bg-white/5", kind === k && "bg-white/5")}>
                      <span className="text-muted">{kindOf(k).label}</span>
                      <span className="font-medium text-ink">{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-5">
            <SectionTitle>Fails most</SectionTitle>
            {top.length === 0 ? (
              <p className="text-sm text-muted">No failing actions.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {top.map(([t, n]) => (
                  <li key={t} className="flex justify-between gap-2">
                    <span className="truncate text-muted">{t}</span>
                    <span className="font-medium text-ink">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {(items ?? []).some((f) => f.resolved) && (
            <Button size="sm" variant="danger" className="w-full" onClick={() => void remove({ resolved: true })}>
              <Trash2 className="size-3.5" /> Clear fixed entries
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
