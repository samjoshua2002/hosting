import { fmtKb, pct } from "./format";
import type { Sample, VmInfo, VmStatus } from "./types";

export type Metric = "cpu" | "memory" | "storage";

export const METRICS: { id: Metric; label: string }[] = [
  { id: "cpu", label: "Compute" },
  { id: "memory", label: "Memory" },
  { id: "storage", label: "Storage" },
];

export const RANGES = [
  { id: "15m", label: "15M", sec: 15 * 60, words: "15 minutes" },
  { id: "1h", label: "1H", sec: 60 * 60, words: "hour" },
  { id: "6h", label: "6H", sec: 6 * 60 * 60, words: "6 hours" },
  { id: "all", label: "All", sec: Infinity, words: "session" },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

/** Categorical slots in fixed order (validated). VM i keeps slot i; past 7 they fold into "Others". */
export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"];
export const OTHERS = "var(--others)";

/** Sequential ramp (one hue, dark → bright) for heat cells; step 0 sits near the surface. */
export const HEAT = Array.from({ length: 8 }, (_, i) => `var(--heat-${i})`);

export function seriesColor(vmIndex: number): string {
  return vmIndex < SERIES.length ? SERIES[vmIndex] : OTHERS;
}

/** A sample's value for the metric as a percentage of that VM's capacity. */
function samplePct(s: Sample, metric: Metric, st: VmStatus | undefined): number | null {
  if (metric === "cpu") return s[1];
  const a = st?.agent;
  if (!a) return null;
  return metric === "memory" ? (s[2] * 100) / a.memTotalKb : (s[3] * 100) / a.diskTotalKb;
}

export interface Bucket {
  start: number;
  end: number;
  /** fleet value in %, null when no VM reported in this window */
  value: number | null;
  perVm: Record<string, number | null>;
  reporting: number;
}

export function buildBuckets(
  names: string[],
  history: Record<string, Sample[]>,
  status: Record<string, VmStatus | undefined>,
  metric: Metric,
  rangeSec: number,
  nowSec: number,
  count = 36,
): Bucket[] {
  // never drop samples that arrived after the caller's clock tick
  nowSec = Math.max(nowSec, ...names.map((n) => (history[n]?.at(-1)?.[0] ?? 0) + 1));
  let start = nowSec - rangeSec;
  if (!Number.isFinite(start)) {
    const first = Math.min(...names.map((n) => history[n]?.[0]?.[0] ?? nowSec));
    start = Math.min(first, nowSec - 15 * 60);
  }
  const size = Math.max(nowSec - start, 60) / count;
  const out: Bucket[] = Array.from({ length: count }, (_, i) => ({
    start: start + i * size,
    end: start + (i + 1) * size,
    value: null,
    perVm: {},
    reporting: 0,
  }));

  for (const n of names) {
    const sums = new Array<number>(count).fill(0);
    const counts = new Array<number>(count).fill(0);
    // memory/storage fleet % is weighted by capacity, so track raw KB too
    for (const s of history[n] ?? []) {
      const i = Math.floor((s[0] - start) / size);
      if (i < 0 || i >= count) continue;
      const v = samplePct(s, metric, status[n]);
      if (v === null) continue;
      sums[i] += v;
      counts[i] += 1;
    }
    out.forEach((b, i) => {
      b.perVm[n] = counts[i] ? sums[i] / counts[i] : null;
    });
  }

  for (const b of out) {
    const present = names.filter((n) => b.perVm[n] !== null);
    b.reporting = present.length;
    if (!present.length) continue;
    if (metric === "cpu") {
      b.value = present.reduce((s, n) => s + (b.perVm[n] as number) * (status[n]?.agent?.cores ?? 1), 0) / present.reduce((s, n) => s + (status[n]?.agent?.cores ?? 1), 0);
    } else {
      const cap = (n: string) => (metric === "memory" ? status[n]?.agent?.memTotalKb : status[n]?.agent?.diskTotalKb) ?? 0;
      const total = present.reduce((s, n) => s + cap(n), 0);
      b.value = total ? present.reduce((s, n) => s + ((b.perVm[n] as number) / 100) * cap(n), 0) / (total / 100) : null;
    }
  }
  return out;
}

/** Round a max up to a clean axis top: 1, 2, 5, 10, 20, 25, 50, 100. */
export function niceMax(v: number): number {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 75, 100]) if (v <= step) return step;
  return Math.ceil(v / 10) * 10;
}

export interface Share {
  name: string;
  index: number;
  value: number;
  share: number;
  label: string;
}

/** How much of the fleet's current load/usage each VM accounts for. */
export function shares(vms: VmInfo[], status: Record<string, VmStatus | undefined>, buckets: Bucket[], metric: Metric): Share[] {
  const rows = vms
    .map((v, index) => {
      const a = status[v.name]?.agent;
      if (!a) return null;
      let value: number;
      let label: string;
      if (metric === "cpu") {
        const vals = buckets.map((b) => b.perVm[v.name]).filter((x): x is number => x !== null);
        const avg = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : a.cpuPct;
        value = (avg / 100) * a.cores; // cores' worth of work
        label = `${avg.toFixed(avg < 10 ? 1 : 0)}% CPU`;
      } else if (metric === "memory") {
        value = a.memTotalKb - a.memAvailKb;
        label = fmtKb(value);
      } else {
        value = a.diskUsedKb;
        label = fmtKb(value);
      }
      return { name: v.name, index, value, share: 0, label };
    })
    .filter((x): x is Share => x !== null);
  const total = rows.reduce((s, r) => s + r.value, 0);
  rows.forEach((r) => (r.share = total > 0 ? (r.value * 100) / total : 0));
  return rows.sort((a, b) => b.value - a.value);
}

export interface Totals {
  online: number;
  total: number;
  cores: number;
  memTotal: number;
  memUsed: number;
  diskTotal: number;
  diskUsed: number;
  /** largest free space on any one machine: the biggest file or app you can actually place */
  diskFreeMax: number;
  /** most free memory on any one machine: the biggest single program (model, game server) you can start */
  memFreeMax: number;
  disks: number;
  cpuAvg: number;
  projects: number;
  projectsLive: number;
  projectsFailed: number;
  jobsRunning: number;
}

export function totals(vms: VmInfo[], status: Record<string, VmStatus | undefined>): Totals {
  const agents = vms.filter((v) => status[v.name]?.ok && status[v.name]?.agent).map((v) => status[v.name]!.agent!);
  const cores = agents.reduce((s, a) => s + a.cores, 0);
  const projects = agents.flatMap((a) => a.projects);
  return {
    online: vms.filter((v) => status[v.name]?.ok).length,
    total: vms.length,
    cores,
    memTotal: agents.reduce((s, a) => s + a.memTotalKb, 0),
    memUsed: agents.reduce((s, a) => s + a.memTotalKb - a.memAvailKb, 0),
    diskTotal: agents.reduce((s, a) => s + a.diskTotalKb, 0),
    diskUsed: agents.reduce((s, a) => s + a.diskUsedKb, 0),
    diskFreeMax: Math.max(0, ...agents.map((a) => a.diskTotalKb - a.diskUsedKb)),
    memFreeMax: Math.max(0, ...agents.map((a) => a.memAvailKb)),
    disks: agents.length,
    cpuAvg: cores ? agents.reduce((s, a) => s + a.cpuPct * a.cores, 0) / cores : 0,
    projects: projects.length,
    projectsLive: projects.filter((p) => p.active === "active").length,
    projectsFailed: projects.filter((p) => p.active === "failed").length,
    jobsRunning: agents.flatMap((a) => a.jobs).filter((j) => j.state === "running").length,
  };
}

/** Per-VM usage in % for ranking. */
export function vmPct(st: VmStatus | undefined, metric: Metric): number | null {
  const a = st?.agent;
  if (!a) return null;
  if (metric === "cpu") return a.cpuPct;
  if (metric === "memory") return pct(a.memTotalKb - a.memAvailKb, a.memTotalKb);
  return pct(a.diskUsedKb, a.diskTotalKb);
}

/** Bytes moved (rx + tx) in the window, from counter deltas (resets are skipped). */
export function trafficBytes(samples: Sample[] | undefined, fromSec: number): number {
  if (!samples) return 0;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b[0] < fromSec) continue;
    const d = b[5] - a[5] + (b[6] - a[6]);
    if (d > 0) total += d;
  }
  return total;
}

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}

export function fmtClock(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
