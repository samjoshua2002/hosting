"use client";

import { AudioLines, Check, ChevronRight, FileText, ListChecks, Loader2, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import type { Item } from "@/lib/assistant-items";
import { useStored } from "@/lib/client";
import { answer, decide } from "./assistant-store";
import { ArtifactCard } from "./artifact-view";
import { DiffView, TerminalBlock } from "./chat-blocks";
import { FlowDiagram } from "./flow-diagram";
import { Markdown, inline } from "./markdown";
import { Button, cx } from "./ui";

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Final replies end with ">> suggestion" lines: those are shown as chips, not text. */
export function splitSuggestions(text: string): { body: string; suggestions: string[] } {
  const suggestions: string[] = [];
  const body = text
    .split("\n")
    .filter((l) => {
      const m = /^\s*>>\s*(.+)$/.exec(l);
      if (m) suggestions.push(m[1].trim());
      return !m;
    })
    .join("\n")
    .trim();
  return { body, suggestions };
}

/** A conversation: commands as terminals, other steps grouped, approvals and questions you can act on. */
export function ChatItems({
  sid,
  items,
  busy,
  mentions,
  compact,
  onOpenArtifact,
  onOpenFile,
}: {
  sid: string;
  items: Item[];
  busy: boolean;
  mentions: Set<string>;
  compact?: boolean;
  onOpenArtifact?: (id: string) => void;
  onOpenFile?: (f: { id: string; name: string }) => void;
}) {
  const blocks: ({ kind: "steps"; steps: Extract<Item, { kind: "step" }>[]; key: string } | { kind: "one"; item: Item; key: string })[] = [];
  items.forEach((it, idx) => {
    const last = blocks[blocks.length - 1];
    if (it.kind === "step" && !it.shell) {
      if (last?.kind === "steps") last.steps.push(it);
      else blocks.push({ kind: "steps", steps: [it], key: `g${idx}` });
    } else blocks.push({ kind: "one", item: it, key: `i${idx}` });
  });
  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {blocks.map((b) =>
        b.kind === "steps" ? (
          <StepGroup key={b.key} steps={b.steps} />
        ) : (
          <Bubble
            key={b.key}
            item={b.item}
            busy={busy}
            onDecide={(id, ok) => decide(sid, id, ok)}
            onAnswer={(id, t) => answer(sid, id, t)}
            sessionId={sid}
            mentions={mentions}
            onOpenArtifact={onOpenArtifact}
            onOpenFile={onOpenFile}
          />
        ),
      )}
    </div>
  );
}

function StepGroup({ steps }: { steps: Extract<Item, { kind: "step" }>[] }) {
  // Settings → Code → transcript detail: "verbose" shows every step's details by default
  const [detail] = useStored<"normal" | "verbose">("hosting.assistant.detail", "normal");
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? detail === "verbose";
  const running = steps.find((s) => s.running);
  const failed = steps.filter((s) => !s.running && s.ok === false).length;
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex max-w-full items-center gap-2 py-1 text-sm text-muted hover:text-white">
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" /> : <ChevronRight className={cx("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />}
        {running ? (
          <span className="truncate">{inline(running.label)}</span>
        ) : (
          <span>
            Ran {steps.length} step{steps.length === 1 ? "" : "s"}
            {failed > 0 && <span className="text-[var(--critical-text)]"> · {failed} failed</span>}
          </span>
        )}
      </button>
      {(open || running) && (
        <div className="mt-1 space-y-1 border-l border-white/10 pl-4">
          {steps.map((s, i) => (
            <StepRow key={s.id + i} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Extract<Item, { kind: "step" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} disabled={!step.output} className="flex w-full items-center gap-2 py-0.5 text-left text-[12.5px]">
        {step.running ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
        ) : step.ok ? (
          <Check className="size-3 shrink-0 text-accent" />
        ) : (
          <X className="size-3 shrink-0 text-[var(--critical-text)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-ink/85">{inline(step.label)}</span>
      </button>
      {open && step.output && (
        <pre className="scroll-thin my-1 max-h-64 overflow-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-zinc-300">{step.output}</pre>
      )}
    </div>
  );
}

function Bubble({
  item,
  busy,
  onDecide,
  onAnswer,
  sessionId,
  mentions,
  onOpenArtifact,
  onOpenFile,
}: {
  item: Item;
  busy: boolean;
  onDecide: (id: string, ok: boolean) => void;
  onAnswer: (id: string, text: string) => void;
  sessionId: string;
  mentions: Set<string>;
  onOpenArtifact?: (id: string) => void;
  onOpenFile?: (f: { id: string; name: string }) => void;
}) {
  if (item.kind === "user")
    return (
      <div className="flex flex-col items-end gap-1.5 pt-3">
        {item.voice && (
          <span className="flex items-center gap-1 text-[11px] text-zinc-500">
            <AudioLines className="size-3" /> said in voice mode
          </span>
        )}
        {item.text && (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.08] px-4 py-2.5 text-sm whitespace-pre-wrap text-white ring-1 ring-white/10">{inline(item.text, mentions)}</div>
        )}
        {item.files?.map((f) => (
          <a
            key={f.id}
            href={`/api/attachments?session=${sessionId}&id=${f.id}`}
            onClick={(e) => {
              // open the preview panel; the link still works for "open in new tab" and download
              if (!onOpenFile || e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              onOpenFile({ id: f.id, name: f.name });
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-panel px-2.5 py-1 text-xs text-ink transition-colors hover:border-white/25 hover:text-white"
            title="Preview"
          >
            <FileText className="size-3.5" /> {f.name} <span className="text-muted">{fmtSize(f.size)}</span>
          </a>
        ))}
      </div>
    );
  if (item.kind === "text") {
    const { body } = splitSuggestions(item.text);
    return body ? (
      <div className="py-1 text-[14.5px] leading-relaxed">
        {item.voice && (
          <span className="mb-1 flex items-center gap-1 text-[11px] text-zinc-500">
            <AudioLines className="size-3" /> voice reply
          </span>
        )}
        <Markdown text={body} />
      </div>
    ) : null;
  }
  if (item.kind === "step" && item.shell) return <TerminalBlock shell={item.shell} output={item.output} running={item.running} ok={item.ok} />;
  if (item.kind === "plan") return <PlanCard plan={item} />;
  if (item.kind === "image")
    return (
      <figure className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/30">
        <a href={item.src} target="_blank" rel="noreferrer" title="Open full size">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.src} alt={item.title} className="max-h-[420px] w-full object-cover object-top" loading="lazy" />
        </a>
        <figcaption className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2 text-xs text-zinc-400">
          <span className="truncate text-zinc-300">{item.title}</span>
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-accent-soft hover:underline">
              open page
            </a>
          )}
        </figcaption>
        {item.caption && <p className="border-t border-white/[0.06] px-3 py-2 text-xs leading-relaxed text-zinc-400">{item.caption}</p>}
      </figure>
    );
  if (item.kind === "diagram") return <FlowDiagram title={item.title} nodes={item.nodes} edges={item.edges} />;
  if (item.kind === "artifact") return <ArtifactCard a={item} onOpen={() => onOpenArtifact?.(item.id)} />;
  if (item.kind === "question")
    return (
      <div className="rounded-2xl border border-white/[0.1] bg-panel p-5">
        <p className="text-[15px] font-medium text-white">{item.question}</p>
        {item.answer === undefined ? (
          <>
            {item.options.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5">
                {item.options.map((o) => (
                  <button
                    key={o}
                    disabled={busy}
                    onClick={() => onAnswer(item.id, o)}
                    className="rounded-xl border border-white/10 px-4 py-2.5 text-left text-sm text-ink hover:border-accent/60 hover:bg-white/[0.03] disabled:opacity-50"
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-muted">Or type your own answer below.</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">{item.answer}</p>
        )}
      </div>
    );
  if (item.kind === "approval")
    return (
      <div className={cx("rounded-2xl border p-4", item.decision === undefined ? "border-[var(--warning)]/50 bg-panel" : "border-white/[0.06] opacity-70")}>
        <p className="flex items-center gap-2 text-sm font-semibold text-white">
          <ShieldAlert className="size-4 shrink-0 text-[var(--warning)]" /> {item.diff ? "Review this change" : "Needs your OK"}
        </p>
        <p className="mt-1 text-sm text-ink/85">{inline(item.label)}</p>
        {item.detail &&
          (item.diff ? (
            <div className="mt-3">
              <DiffView text={item.detail} />
            </div>
          ) : (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] text-ink">{item.detail}</pre>
          ))}
        {item.decision === undefined ? (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => onDecide(item.id, true)} disabled={busy}>
              <Check className="size-3.5" /> {item.diff ? "Commit" : "Approve"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDecide(item.id, false)} disabled={busy}>
              <X className="size-3.5" /> Decline
            </Button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">{item.decision ? "Approved" : "Declined"}</p>
        )}
      </div>
    );
  return null;
}


/** The Assistant's live plan: a checklist that ticks itself off while it works. */
export function PlanCard({ plan, compact }: { plan: Extract<Item, { kind: "plan" }>; compact?: boolean }) {
  const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const pct = plan.steps.length ? Math.round((done / plan.steps.length) * 100) : 0;
  const failed = plan.steps.some((s) => s.status === "failed");
  return (
    <div className={cx("rounded-xl border border-white/[0.07] bg-white/[0.02]", compact ? "p-3" : "p-4")}>
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 text-[var(--accent)]" />
        <p className="flex-1 truncate text-sm font-medium text-white">{plan.title}</p>
        <span className={cx("text-xs tabular-nums", failed ? "text-[var(--critical-text)]" : "text-muted")}>
          {done}/{plan.steps.length}
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={cx("h-full rounded-full transition-[width] duration-500", failed ? "bg-[var(--critical)]" : "bg-[var(--accent)]")} style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-3 space-y-1.5">
        {plan.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
              {s.status === "done" ? (
                <Check className="size-3.5 text-[var(--good)]" />
              ) : s.status === "doing" ? (
                <Loader2 className="size-3.5 animate-spin text-[var(--accent)]" />
              ) : s.status === "failed" ? (
                <X className="size-3.5 text-[var(--critical)]" />
              ) : (
                <span className={cx("size-1.5 rounded-full", s.status === "skipped" ? "bg-zinc-700" : "bg-zinc-500")} />
              )}
            </span>
            <span className={cx("min-w-0", s.status === "done" || s.status === "skipped" ? "text-zinc-500" : s.status === "doing" ? "text-white" : s.status === "failed" ? "text-[var(--critical-text)]" : "text-zinc-300", s.status === "skipped" && "line-through")}>
              {s.text}
              {s.note && <span className="block text-xs text-zinc-500">{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
