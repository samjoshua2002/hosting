"use client";

import { useState, type ReactNode } from "react";
import { HEAT, fmtClock, niceMax, type Bucket } from "@/lib/analytics";
import { cx } from "./ui";

/* Tooltip: value leads, label follows. Text content only (labels are data). */
function Tip({ x, children }: { x: number; children: ReactNode }) {
  // Constrain tooltip within bounds
  const clampedX = Math.max(8, Math.min(92, x));
  return (
    <div
      className="pointer-events-none absolute -top-3 z-30 -translate-x-1/2 -translate-y-full rounded-xl border border-[var(--line-strong)] bg-[var(--pop)]/95 px-3 py-2 text-[11px] whitespace-nowrap shadow-2xl backdrop-blur-md transition-all duration-75 text-[var(--text)]"
      style={{ left: `${clampedX}%` }}
    >
      {children}
    </div>
  );
}

/**
 * Column chart, one series (the title names it, so no legend). Bars with subtle vertical gradient,
 * sculpted tops, hairline gridlines responsive to light/dark themes, and rich interactive tooltip.
 */
export function ColumnChart({
  buckets,
  unit = "%",
  height = 220,
  emptyText,
}: {
  buckets: Bucket[];
  unit?: string;
  /** pixels, or "fill" to take the parent's height */
  height?: number | "fill";
  emptyText: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = buckets.map((b) => b.value ?? 0);
  const maxVal = Math.max(1, ...values);
  const top = niceMax(maxVal);
  const ticks = [top, top / 2, 0];
  const hasData = buckets.some((b) => b.value !== null);
  const activeIdx = hover ?? (buckets.length ? buckets.length - 1 : null);

  return (
    <div className={height === "fill" ? "flex flex-1 flex-col" : undefined}>
      <div className={cx("relative flex gap-3", height === "fill" && "min-h-0 flex-1")} style={height === "fill" ? undefined : { height }}>
        {/* Y Axis ticks */}
        <div className="flex w-9 shrink-0 flex-col justify-between py-1 text-right text-[10px] tabular-nums font-mono text-muted select-none">
          {ticks.map((t) => (
            <span key={t} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {Number.isInteger(t) ? t : t.toFixed(1)}
              {unit}
            </span>
          ))}
        </div>

        {/* Chart canvas area */}
        <div className="relative flex-1">
          {/* Subtle dashed grid lines visible across dark and light themes */}
          {[0, 50, 100].map((p) => (
            <div
              key={p}
              className={cx(
                "absolute inset-x-0 h-px",
                p === 100 ? "border-b border-[var(--line-strong)]" : "border-b border-dashed border-[var(--line)]",
              )}
              style={{ top: `${p}%` }}
            />
          ))}

          {!hasData && (
            <div className="absolute inset-0 grid place-items-center text-xs text-muted">
              <span className="rounded-lg border border-[var(--line)] bg-[var(--panel-2)]/60 px-3 py-1.5 backdrop-blur-sm">
                {emptyText}
              </span>
            </div>
          )}

          {/* Interactive Column track container */}
          <div className="absolute inset-0 flex items-end gap-[3px] pt-2" onPointerLeave={() => setHover(null)}>
            {buckets.map((b, i) => {
              const isSelected = hover === i;
              const isCurrent = hover === null && i === buckets.length - 1;
              const isHighlighted = isSelected || isCurrent;
              const hPct = b.value !== null ? Math.max((b.value / top) * 100, b.value > 0 ? 3 : 1) : 0;

              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`${fmtClock(b.start)}: ${b.value === null ? "no data" : `${b.value.toFixed(1)}${unit}`}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="group relative flex h-full flex-1 items-end justify-center rounded-t-sm focus:outline-none transition-colors"
                >
                  {/* Subtle column hover guide */}
                  <span
                    className={cx(
                      "pointer-events-none absolute inset-0 rounded-t-md transition-opacity duration-150",
                      isSelected ? "bg-[var(--accent)]/[0.08]" : "opacity-0 group-hover:opacity-100 group-hover:bg-[var(--line)]/30",
                    )}
                  />

                  {b.value !== null && (
                    <span
                      className={cx(
                        "relative block w-full max-w-[14px] rounded-t-[5px] transition-all duration-300",
                        isHighlighted
                          ? "bg-gradient-to-t from-[var(--accent-deep)] via-[var(--accent)] to-[var(--accent-soft)] shadow-[0_0_12px_var(--glow)]"
                          : "bg-gradient-to-t from-zinc-300 to-zinc-400 dark:from-[var(--line-strong)] dark:to-white/[0.22] hover:from-[var(--accent-deep)]/60 hover:to-[var(--accent)]/80",
                      )}
                      style={{ height: `${hPct}%` }}
                    >
                      {/* Top highlight crest on bar */}
                      <span
                        className={cx(
                          "absolute inset-x-0 top-0 h-[2px] rounded-t-[5px]",
                          isHighlighted ? "bg-white/80" : "bg-white/30 dark:bg-white/20",
                        )}
                      />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Active / Hover Tooltip */}
          {hover !== null && buckets[hover] && (
            <Tip x={((hover + 0.5) / buckets.length) * 100}>
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-[var(--accent)] animate-pulse" />
                <span className="text-sm font-semibold tracking-tight text-[var(--text)] tabular-nums">
                  {buckets[hover].value === null ? "No data" : `${buckets[hover].value!.toFixed(1)}${unit}`}
                </span>
                <span className="rounded bg-[var(--line)] px-1.5 py-0.5 font-mono text-[9px] text-muted uppercase">
                  {buckets[hover].value === null ? "Inactive" : "Telemetry"}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {fmtClock(buckets[hover].start)} – {fmtClock(buckets[hover].end)}
                <span className="mx-1.5 opacity-40">·</span>
                {buckets[hover].reporting} machine{buckets[hover].reporting === 1 ? "" : "s"} reporting
              </div>
            </Tip>
          )}
        </div>
      </div>

      {/* X Axis timeline */}
      <div className="mt-2.5 flex items-center justify-between pl-12 text-[10px] font-mono text-muted select-none">
        <span>{buckets.length ? fmtClock(buckets[0].start) : ""}</span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-[var(--accent)]" />
          <span>Now</span>
        </span>
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
    <div className="inline-flex rounded-full border border-[var(--line-strong)] bg-transparent p-1" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            "rounded-full font-semibold transition-colors",
            size === "md" ? "px-4 py-1.5 text-sm" : "px-3 py-1 text-xs",
            value === o.id ? "bg-white/[0.1] text-white" : "text-muted hover:text-white",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
