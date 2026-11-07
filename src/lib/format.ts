import type { VmStatus } from "./types";

export function fmtKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function timeAgo(ms: number | null | undefined, now?: number): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round(((now ?? Date.now()) - ms) / 1000));
  if (s < 5) return "just now";
  return `${fmtDuration(s)} ago`;
}

export function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part * 100) / total) : 0;
}

export type VmState = "online" | "offline" | "checking" | "unknown";

export function vmState(s: VmStatus | undefined, checking: boolean): VmState {
  if (s?.ok) return "online";
  if (checking) return "checking";
  if (s && !s.ok) return "offline";
  return "unknown";
}

export interface VmMetrics {
  cpu: number;
  memPct: number;
  memUsedKb: number;
  memTotalKb: number;
  diskPct: number;
  diskUsedKb: number;
  diskTotalKb: number;
  load1: number;
  cores: number;
}

export function vmMetrics(s: VmStatus | undefined): VmMetrics | null {
  const a = s?.ok ? s.agent : undefined;
  if (!a) return null;
  const memUsedKb = a.memTotalKb - a.memAvailKb;
  return {
    cpu: a.cpuPct,
    memPct: pct(memUsedKb, a.memTotalKb),
    memUsedKb,
    memTotalKb: a.memTotalKb,
    diskPct: pct(a.diskUsedKb, a.diskTotalKb),
    diskUsedKb: a.diskUsedKb,
    diskTotalKb: a.diskTotalKb,
    load1: a.load[0],
    cores: a.cores,
  };
}
