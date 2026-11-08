"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, apiStream, useStored } from "@/lib/client";
import type { ExecResult, JobStartResult, Sample, VmInfo, VmStatus } from "@/lib/types";
import { JobDrawer } from "./job-drawer";

export interface ClusterEvent {
  id: number;
  ts: number;
  vm: string | null;
  kind: "dispatch" | "ok" | "fail" | "job" | "info";
  text: string;
}

interface Inflight {
  command: string;
  startedAt: number;
}

interface OpenJob {
  vm: string;
  id: string;
  title: string;
}

interface ClusterCtx {
  vms: VmInfo[];
  configErrors: string[];
  agentVersion: string;
  hostKeyPinned: boolean;
  loaded: boolean;
  status: Record<string, VmStatus | undefined>;
  /** Metrics samples per VM, merged across refreshes (the agent only sends new ones). */
  history: Record<string, Sample[]>;
  checking: Record<string, boolean>;
  refresh: (names?: string[]) => Promise<void>;
  /** fetch the machine list again (after adding or removing one) */
  reloadVms: () => Promise<void>;
  auto: boolean;
  setAuto: (v: boolean) => void;
  inflight: Record<string, Inflight | undefined>;
  results: Record<string, ExecResult | undefined>;
  exec: (targets: string[], command: string, onResult?: (r: ExecResult) => void) => Promise<ExecResult[]>;
  startJobs: (targets: string[], command: string, label?: string) => Promise<JobStartResult[]>;
  events: ClusterEvent[];
  log: (vm: string | null, kind: ClusterEvent["kind"], text: string) => void;
  openJob: (job: OpenJob) => void;
}

const Ctx = createContext<ClusterCtx | null>(null);

export function useCluster(): ClusterCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCluster outside ClusterProvider");
  return c;
}

const REFRESH_MS = 30_000;
const PARALLEL = 8;

export function ClusterProvider({ children }: { children: ReactNode }) {
  const [vms, setVms] = useState<VmInfo[]>([]);
  const [configErrors, setConfigErrors] = useState<string[]>([]);
  const [agentVersion, setAgentVersion] = useState("");
  const [hostKeyPinned, setHostKeyPinned] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Record<string, VmStatus | undefined>>({});
  const [history, setHistory] = useState<Record<string, Sample[]>>({});
  const lastSample = useRef<Record<string, number>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [auto, setAuto] = useStored<boolean>("hosting.auto", true);
  const [inflight, setInflight] = useState<Record<string, Inflight | undefined>>({});
  const [results, setResults] = useState<Record<string, ExecResult | undefined>>({});
  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const [job, setJob] = useState<OpenJob | null>(null);
  const eventId = useRef(0);
  const vmsRef = useRef<VmInfo[]>([]);
  const busy = useRef(new Set<string>());
  const pendingAlerts = useRef<{ tone: string; title: string; detail?: string }[]>([]);
  const alertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Problems the dashboard notices are emailed (batched for 3s; the server dedupes for 30 min).
  const queueAlert = useCallback((item: { tone: string; title: string; detail?: string }) => {
    pendingAlerts.current.push(item);
    if (alertTimer.current) return;
    alertTimer.current = setTimeout(() => {
      const items = pendingAlerts.current.splice(0);
      alertTimer.current = null;
      void api("/api/alerts/notify", { items }).catch(() => {});
    }, 3000);
  }, []);

  const log = useCallback((vm: string | null, kind: ClusterEvent["kind"], text: string) => {
    const e: ClusterEvent = { id: ++eventId.current, ts: Date.now(), vm, kind, text };
    setEvents((prev) => [e, ...prev].slice(0, 200));
  }, []);

  const refresh = useCallback(async (names?: string[]) => {
    const targets = (names ?? vmsRef.current.map((v) => v.name)).filter((n) => !busy.current.has(n));
    if (!targets.length) return;
    targets.forEach((n) => busy.current.add(n));
    setChecking((c) => ({ ...c, ...Object.fromEntries(targets.map((n) => [n, true])) }));
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const name = targets[next++];
        try {
          const since = lastSample.current[name] ?? 0;
          const data = await api<{ vms: VmStatus[] }>(`/api/status?vm=${encodeURIComponent(name)}&since=${since}`);
          const s = data.vms[0];
          const fresh = s.agent?.history ?? [];
          if (fresh.length) {
            lastSample.current[name] = fresh[fresh.length - 1][0];
            setHistory((h) => ({ ...h, [name]: [...(h[name] ?? []), ...fresh].slice(-2000) }));
          }
          setStatus((prev) => {
            const was = prev[name];
            if (was?.ok && !s.ok) {
              log(name, "fail", `went offline: ${s.error}`);
              queueAlert({ tone: "warning", title: `${name} went offline`, detail: s.error });
            }
            if (was && !was.ok && s.ok) log(name, "ok", "back online");
            const a = s.agent;
            if (a) {
              const disk = Math.round((a.diskUsedKb * 100) / a.diskTotalKb);
              const wasDisk = was?.agent ? Math.round((was.agent.diskUsedKb * 100) / was.agent.diskTotalKb) : 0;
              if (disk >= 85 && wasDisk < 85) queueAlert({ tone: "critical", title: `${name} disk ${disk}% full`, detail: `${((a.diskTotalKb - a.diskUsedKb) / 1048576).toFixed(1)} GB left` });
              for (const p of a.projects) {
                const before = was?.agent?.projects.find((x) => x.manifest.name === p.manifest.name)?.active;
                if (p.active === "failed" && before !== "failed") {
                  log(name, "fail", `project ${p.manifest.name} failed`);
                  queueAlert({ tone: "critical", title: `${p.manifest.name} failed on ${name}`, detail: "Open Projects → Logs to see why." });
                }
              }
            }
            return { ...prev, [name]: s };
          });
        } catch (e) {
          setStatus((prev) => ({
            ...prev,
            [name]: { name, ok: false, error: (e as Error).message, ms: 0, checkedAt: Date.now() },
          }));
        } finally {
          busy.current.delete(name);
          setChecking((c) => ({ ...c, [name]: false }));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, targets.length) }, worker));
  }, [log, queueAlert]);

  // Load the VM list (again after a machine is added or removed), then probe everything.
  const reloadVms = useCallback(async () => {
    try {
      const d = await api<{ vms: VmInfo[]; errors: string[]; agentVersion: string; hostKeyPinned: boolean }>("/api/vms");
      const isNew = d.vms.filter((v) => !vmsRef.current.some((o) => o.name === v.name)).map((v) => v.name);
      vmsRef.current = d.vms;
      setVms(d.vms);
      setConfigErrors(d.errors);
      setAgentVersion(d.agentVersion);
      setHostKeyPinned(d.hostKeyPinned);
      setLoaded(true);
      log(null, "info", `control plane connected, ${d.vms.length} VM${d.vms.length === 1 ? "" : "s"} configured`);
      void refresh(isNew.length && isNew.length < d.vms.length ? isNew : undefined);
    } catch (e) {
      setConfigErrors([(e as Error).message]);
      setLoaded(true);
    }
  }, [log, refresh]);
  useEffect(() => {
    queueMicrotask(() => void reloadVms());
  }, [reloadVms]);

  // Auto refresh while the tab is visible.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, refresh]);

  const exec = useCallback(
    async (targets: string[], command: string, onResult?: (r: ExecResult) => void) => {
      const startedAt = Date.now();
      setInflight((p) => ({ ...p, ...Object.fromEntries(targets.map((t) => [t, { command, startedAt }])) }));
      targets.forEach((t) => log(t, "dispatch", command));
      const out: ExecResult[] = [];
      const settle = (res: ExecResult) => {
        const r = { ...res, command };
        out.push(r);
        setInflight((p) => ({ ...p, [r.vm]: undefined }));
        setResults((p) => ({ ...p, [r.vm]: r }));
        log(r.vm, r.code === 0 ? "ok" : "fail", r.error ?? `exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`);
        onResult?.(r);
      };
      try {
        await apiStream<ExecResult>("/api/exec", { targets, command }, settle);
      } catch (e) {
        for (const t of targets)
          if (!out.find((r) => r.vm === t))
            settle({ vm: t, code: null, stdout: "", stderr: "", ms: Date.now() - startedAt, error: (e as Error).message });
      }
      return out;
    },
    [log],
  );

  const startJobs = useCallback(
    async (targets: string[], command: string, label?: string) => {
      targets.forEach((t) => log(t, "dispatch", `[background] ${command}`));
      const { jobs } = await api<{ jobs: JobStartResult[] }>("/api/jobs", { targets, command, label });
      jobs.forEach((j) => log(j.vm, j.error ? "fail" : "job", j.error ?? `job ${j.id} started`));
      void refresh(targets);
      return jobs;
    },
    [log, refresh],
  );

  const value = useMemo<ClusterCtx>(
    () => ({
      vms,
      configErrors,
      agentVersion,
      hostKeyPinned,
      loaded,
      status,
      history,
      checking,
      refresh,
      auto,
      setAuto,
      inflight,
      results,
      exec,
      startJobs,
      events,
      log,
      reloadVms,
      openJob: setJob,
    }),
    [vms, configErrors, agentVersion, hostKeyPinned, loaded, status, history, checking, refresh, reloadVms, auto, setAuto, inflight, results, exec, startJobs, events, log],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {job && (
        <JobDrawer
          job={job}
          onClose={() => {
            setJob(null);
            void refresh([job.vm]);
          }}
        />
      )}
    </Ctx.Provider>
  );
}
