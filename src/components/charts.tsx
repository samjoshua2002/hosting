"use client";

import { useState, type ReactNode } from "react";
import { HEAT, fmtClock, niceMax, type Bucket } from "@/lib/analytics";
import { cx } from "./ui";

/* Tooltip: value leads, label follows. Text content only (labels are data). */
function Tip({ x, children }: { x: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-white/10 bg-bg/95 px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-xl backdrop-blur"
      style={{ left: `${x}%` }}
    >
      {children}
    </div>
  );
}

/**
 * Column chart, one series (the title names it, so no legend). Bars ≤24px, 4px rounded tops,
 * square at the baseline, 2px surface gaps, hairline solid gridlines, per-bar hover/focus tooltip.
 */
export function ColumnChart({
  buckets,
  unit = "%",
  height = 220,
  emptyText,
}: {
  buckets: Bucket[];
  unit?: string;
  height?: number;
  emptyText: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = buckets.map((b) => b.value ?? 0);
  const top = niceMax(Math.max(1, ...values));
  const ticks = [top, top / 2, 0];
  const hasData = buckets.some((b) => b.value !== null);

  return (
    <div>
      <div className="relative flex gap-3" style={{ height }}>
        <div className="flex w-9 shrink-0 flex-col justify-between py-0 text-right text-[10px] tabular-nums text-muted">
          {ticks.map((t) => (
            <span key={t} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {Number.isInteger(t) ? t : t.toFixed(1)}
              {unit}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {[0, 50, 100].map((p) => (
            <div key={p} className="absolute inset-x-0 h-px bg-white/[0.06]" style={{ top: `${p}%` }} />
          ))}
          {!hasData && <div className="absolute inset-0 grid place-items-center text-xs text-muted">{emptyText}</div>}
          <div className="absolute inset-0 flex items-end gap-[2px]" onPointerLeave={() => setHover(null)}>
            {buckets.map((b, i) => (
              <button
                key={i}
                type="button"
                aria-label={`${fmtClock(b.start)}: ${b.value === null ? "no data" : `${b.value.toFixed(1)}${unit}`}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="group flex h-full flex-1 items-end justify-center focus:outline-none"
              >
                {b.value !== null && (
                  <span
                    className={cx(
                      "block w-full max-w-6 rounded-t-[4px] transition-[height,background-color] duration-500",
                      hover === i ? "bg-[var(--accent-soft)]" : "bg-[var(--accent)]",
                    )}
                    style={{ height: `${Math.max((b.value / top) * 100, b.value > 0 ? 1.5 : 0.6)}%` }}
                  />
                )}
              </button>
            ))}
          </div>
          {hover !== null && (
            <Tip x={((hover + 0.5) / buckets.length) * 100}>
              <div className="text-sm font-semibold text-white">
                {buckets[hover].value === null ? "No data" : `${buckets[hover].value!.toFixed(1)}${unit}`}
              </div>
              <div className="text-muted">
                {fmtClock(buckets[hover].start)}–{fmtClock(buckets[hover].end)} · {buckets[hover].reporting} reporting
              </div>
            </Tip>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-12 text-[10px] text-muted">
        <span>{buckets.length ? fmtClock(buckets[0].start) : ""}</span>
        <span>Now</span>
      </div>
    </div>
  );
}

/** Heat grid: rows = VMs, columns = time windows, one-hue sequential ramp scaled to the busiest cell. */
export function Heatmap({ rows, buckets, unit = "%" }: { rows: string[]; buckets: Bucket[]; unit?: string }) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const max = Math.max(5, ...buckets.flatMap((b) => rows.map((r) => b.perVm[r] ?? 0)));
  const step = (v: number) => Math.min(HEAT.length - 1, Math.floor((v / max) * (HEAT.length - 1) + 0.0001));

  return (
    <div className="relative" onPointerLeave={() => setHover(null)}>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `52px repeat(${buckets.length}, minmax(0, 1fr))` }}>
        {rows.map((r, ri) => (
          <div key={r} className="contents">
            <span className="pr-2 font-mono text-[11px] leading-5 text-muted">{r}</span>
            {buckets.map((b, ci) => {
              const v = b.perVm[r];
              return (
                <button
                  key={ci}
                  type="button"
                  aria-label={`${r} ${fmtClock(b.start)}: ${v == null ? "no data" : `${v.toFixed(1)}${unit}`}`}
                  onPointerEnter={() => setHover({ r: ri, c: ci })}
                  onFocus={() => setHover({ r: ri, c: ci })}
                  className={cx(
                    "h-5 rounded-[4px] transition-transform focus:outline-none",
                    v == null && "border border-white/[0.05]",
                    hover?.r === ri && hover.c === ci && "scale-110 ring-1 ring-white/60",
                  )}
                  style={v == null ? undefined : { background: HEAT[step(v)] }}
                />
              );
            })}
          </div>
        ))}
      </div>
      {hover && (
        <Tip x={((hover.c + 0.5) / buckets.length) * 100}>
          <div className="text-sm font-semibold text-white">
            {buckets[hover.c].perVm[rows[hover.r]] == null ? "No data" : `${buckets[hover.c].perVm[rows[hover.r]]!.toFixed(1)}${unit}`}
          </div>
          <div className="text-muted">
            {rows[hover.r]} · {fmtClock(buckets[hover.c].start)}
          </div>
        </Tip>
      )}
      <div className="mt-2 flex justify-between pl-[55px] text-[10px] text-muted">
        <span>{buckets.length ? fmtClock(buckets[0].start) : ""}</span>
        <span>{buckets.length ? fmtClock(buckets[Math.floor(buckets.length / 2)].start) : ""}</span>
        <span>Now</span>
      </div>
    </div>
  );
}

export function HeatLegend() {
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted">
      Quiet
      {[1, 3, 5, 7].map((i) => (
        <span key={i} className="size-3 rounded-[3px]" style={{ background: HEAT[i] }} />
      ))}
      Busy
    </span>
  );
}

/** Thin segmented bar: one whole split into parts, 2px surface gaps, fully rounded ends, no text. */
export function SegmentBar({ parts, height = 10 }: { parts: { key: string; value: number; color: string; title: string }[]; height?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }} role="img" aria-label={parts.map((p) => p.title).join(", ")}>
      {total === 0 ? (
        <span className="h-full w-full rounded-full bg-white/[0.06]" />
      ) : (
        parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.key}
              title={p.title}
              className="h-full first:rounded-l-full last:rounded-r-full transition-[flex-grow] duration-700"
              style={{ flexGrow: p.value, flexBasis: 0, minWidth: 3, background: p.color }}
            />
          ))
      )}
    </div>
  );
}

/** Segmented control, pill style (white active pill like the Chatter OS dashboard). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  size?: "md" | "sm";
}) {
  return (
    <div className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.04] p-1 backdrop-blur" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            "rounded-full font-semibold transition-colors",
            size === "md" ? "px-4 py-1.5 text-sm" : "px-3 py-1 text-xs",
            value === o.id ? "bg-white text-[#0b0e1c] shadow" : "text-ink/80 hover:text-white",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
