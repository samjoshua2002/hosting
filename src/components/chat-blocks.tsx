"use client";

import { useNiceLink } from "./nice-links";

import { Check, ChevronDown, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Shell } from "@/lib/assistant-items";
import { cx } from "./ui";

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/[0.08] hover:text-white", className)}
      title={label ?? "Copy"}
    >
      {done ? <Check className="size-3.5 text-accent-soft" /> : <Copy className="size-3.5" />}
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

/** A link as a chip: open it, or copy it. */
export function LinkChip({ href: raw, children }: { href: string; children?: ReactNode }) {
  const nice = useNiceLink();
  const href = nice(raw);
  // the model's own label is usually the raw address: show the short link instead when we swapped it
  if (href !== raw && typeof children === "string" && /instabox\.tech/.test(children)) children = undefined;
  let shown = href;
  try {
    const u = new URL(href);
    shown = `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {}
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-lg border border-line-strong bg-white/[0.03] py-0.5 pr-0.5 pl-2 align-middle">
      <a href={href} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 text-[13px] text-accent-soft hover:underline">
        <span className="truncate">{children ?? shown}</span>
        <ExternalLink className="size-3 shrink-0" />
      </a>
      <CopyButton text={href} label="Copy link" />
    </span>
  );
}

const SECTION = /^\[([\w.-]+)\] (exit (\S+)|could not connect: .*)$/;

/** Split "[box1] exit 0\n…\n\n[box2] exit 1\n…" into per-machine parts. */
function sections(output: string): { vm: string; exit: string; body: string }[] {
  const out: { vm: string; exit: string; body: string }[] = [];
  for (const line of output.split("\n")) {
    const m = SECTION.exec(line);
    if (m) out.push({ vm: m[1], exit: m[3] ?? "no connection", body: m[3] ? "" : line.replace(/^\[[^\]]+\] /, "") });
    else if (out.length) out[out.length - 1].body += (out[out.length - 1].body ? "\n" : "") + line;
  }
  return out.map((s) => ({ ...s, body: s.body.replace(/\n+$/, "") }));
}

/** A command step drawn like a real terminal: prompt, command, output, exit code. */
export function TerminalBlock({ shell, output, running, ok }: { shell: Shell; output?: string; running: boolean; ok?: boolean }) {
  const [open, setOpen] = useState(false);
  const parts = output ? sections(output) : [];
  const vms = shell.vms.filter(Boolean);
  const prompt = (vm?: string) => shell.prompt ?? `user@${vm ?? (vms[0] || "box")}:~$`;
  let body: { vm?: string; exit?: string; text: string }[];
  if (parts.length) body = parts.map((p) => ({ vm: p.vm, exit: p.exit, text: p.body }));
  else if (output) {
    // background jobs answer with JSON ids
    let text = output;
    try {
      const j = JSON.parse(output) as { vm: string; id?: string; error?: string }[];
      if (Array.isArray(j)) text = j.map((x) => (x.id ? `[${x.vm}] started in the background · job ${x.id}` : `[${x.vm}] ${x.error}`)).join("\n");
    } catch {}
    body = [{ text }];
  } else body = [];
  const lines = body.reduce((n, b) => n + b.text.split("\n").length + 1, 0);
  const long = lines > 18;
  const failed = !running && ok === false;
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#07080d] font-mono text-[12px] leading-relaxed shadow-lg shadow-black/30">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-2 rounded-full bg-white/15" />
          ))}
        </span>
        <span className="truncate text-[11px] text-muted">{shell.prompt ? `${shell.prompt.replace(/[=>#$]+$/, "")} — query` : `${vms.join(", ") || "shell"} — bash`}</span>
        <span className="flex-1" />
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-accent" />
        ) : (
          <span className={cx("rounded px-1.5 text-[10.5px]", failed ? "bg-[var(--critical)]/20 text-[var(--critical-text)]" : "bg-white/[0.06] text-muted")}>{failed ? "failed" : "done"}</span>
        )}
        <CopyButton text={shell.command} />
      </div>
      <div className={cx("scroll-thin overflow-x-auto px-3 py-2", !open && long && "max-h-72 overflow-y-hidden")}>
        {(body.length ? body : [{ vm: vms[0], text: "" }]).map((b, i) => (
          <div key={i} className={i ? "mt-2" : ""}>
            <div className="whitespace-pre-wrap">
              <span className="text-accent-soft">{prompt(b.vm)}</span> <span className="text-white">{shell.command}</span>
            </div>
            {b.text && <div className="whitespace-pre-wrap text-zinc-300">{b.text}</div>}
            {b.exit && b.exit !== "0" && <div className="text-[var(--critical-text)]">exit {b.exit}</div>}
          </div>
        ))}
        {running && <span className="inline-block h-3.5 w-1.5 animate-pulse bg-accent-soft align-middle" />}
      </div>
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-center gap-1 border-t border-white/[0.06] py-1 text-[11px] text-muted hover:text-white">
          <ChevronDown className={cx("size-3.5 transition-transform", open && "rotate-180")} /> {open ? "Less" : `Show all ${lines} lines`}
        </button>
      )}
    </div>
  );
}

/** Unified diff with colours; the first line can be a "Branch x" header. */
export function DiffView({ text }: { text: string }) {
  return (
    <div className="scroll-thin max-h-[480px] overflow-auto rounded-lg border border-white/[0.08] bg-[#07080d] py-2 font-mono text-[11.5px] leading-[1.55]">
      {text.split("\n").map((l, i) => {
        const cls = l.startsWith("+++") || l.startsWith("---")
          ? "text-white font-semibold mt-2"
          : l.startsWith("@@")
            ? "text-accent-soft"
            : l.startsWith("+")
              ? "bg-[hsl(140_60%_40%/0.16)] text-[hsl(140_70%_78%)]"
              : l.startsWith("-")
                ? "bg-[var(--critical)]/15 text-[var(--critical-text)]"
                : /^(New branch|Branch) /.test(l)
                  ? "text-muted"
                  : "text-zinc-400";
        return (
          <div key={i} className={cx("px-3 whitespace-pre", cls)}>
            {l || " "}
          </div>
        );
      })}
    </div>
  );
}
