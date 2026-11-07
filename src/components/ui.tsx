"use client";

import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { VmState } from "@/lib/format";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "default" | "ghost" | "danger";

export function Button({
  variant = "default",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "rounded-full bg-white text-[#0b0e1c] hover:bg-white/85 shadow-sm",
        variant === "default" && "border border-[var(--line-strong)] bg-[var(--panel-2)] text-zinc-200 hover:bg-[#20254a]",
        variant === "ghost" && "text-muted hover:bg-white/5 hover:text-zinc-100",
        variant === "danger" && "border border-rose-900/70 bg-rose-950/40 text-rose-300 hover:bg-rose-900/40",
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-2xl border border-white/[0.06] bg-panel/90 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]", className)}>{children}</div>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">{children}</h2>
      {right}
    </div>
  );
}

// Theme colour for normal states; red is kept only for real problems.
const DOT: Record<VmState, string> = {
  online: "bg-accent shadow-[0_0_8px_var(--glow)]",
  offline: "bg-[var(--critical)]",
  checking: "bg-accent animate-pulse-dot",
  unknown: "bg-[var(--others)]",
};

export function StatusDot({ state, className }: { state: VmState; className?: string }) {
  return <span className={cx("inline-block size-2 shrink-0 rounded-full", DOT[state], className)} aria-label={state} />;
}

const BADGE: Record<string, string> = {
  green: "border-accent/35 bg-accent/10 text-ink",
  red: "border-[var(--critical)]/50 bg-[var(--critical)]/15 text-[var(--critical-text)]",
  amber: "border-accent/35 bg-accent/10 text-ink",
  blue: "border-accent/35 bg-accent/10 text-ink",
  gray: "border-line-strong bg-white/[0.03] text-muted",
};

export function Badge({ tone = "gray", children, className }: { tone?: keyof typeof BADGE; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium", BADGE[tone], className)}>
      {children}
    </span>
  );
}

export function serviceTone(active: string): keyof typeof BADGE {
  if (active === "active") return "green";
  if (active === "failed") return "red";
  if (active === "activating" || active === "reloading") return "amber";
  return "gray";
}

export function Meter({ label, value, detail }: { label: string; value: number; detail?: string }) {
  const v = Math.max(0, Math.min(100, value));
  // fill carries severity (accent → warning → critical); track is a darker step of the accent ramp
  const color = v >= 90 ? "bg-[var(--critical)]" : v >= 70 ? "bg-[var(--warning)]" : "bg-[var(--accent)]";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums text-zinc-300">{detail ?? `${v}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-track">
        <div className={cx("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-zinc-600">{icon}</div>}
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {children && <div className="max-w-md text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export function Output({ text, tone = "out", className }: { text: string; tone?: "out" | "err"; className?: string }) {
  if (!text) return null;
  return (
    <pre
      className={cx(
        "scroll-thin max-h-80 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all",
        tone === "err" ? "text-rose-300" : "text-zinc-300",
        className,
      )}
    >
      {text}
    </pre>
  );
}

export const inputCls =
  "w-full rounded-lg border border-[var(--line-strong)] bg-black/25 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--accent)] focus:outline-none";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}
