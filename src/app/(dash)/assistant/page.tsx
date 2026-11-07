"use client";

import { ArrowUpRight, Check, ChevronRight, FileText, Link2, Loader2, MessageSquarePlus, Paperclip, Search, Server, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { addFiles, currentDoc, hydrate, newSession, openSession, removeSession, send, setReview, setTitle, stop, updateItems, useAssistant } from "@/components/assistant-store";
import { CopyButton, DiffView, TerminalBlock } from "@/components/chat-blocks";
import { useCluster } from "@/components/cluster";
import { Composer, contextFor, entitiesFrom } from "@/components/composer";
import { FlowDiagram } from "@/components/flow-diagram";
import { Markdown, inline } from "@/components/markdown";
import { UnsplashLayer, useTheme } from "@/components/theme";
import { Button, cx } from "@/components/ui";
import type { Att, Item } from "@/lib/assistant-items";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";

const STARTERS = [
  "Check every machine and fix anything that looks wrong",
  "Explain the pipeline of my projects with a diagram",
  "List the tables in my databases with row counts",
  "Show my GitHub repos that aren't deployed yet",
];
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const URL_RE = /https?:\/\/[^\s)<>"'`\]]+/g;

/** Final replies end with ">> suggestion" lines: show them as chips, not text. */
function splitSuggestions(text: string): { body: string; suggestions: string[] } {
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

export default function AssistantPage() {
  const { vms, status, refresh } = useCluster();
  const { photo } = useTheme();
  const st = useAssistant();
  const doc = currentDoc(st);
  const sid = st.current;
  const { items, files, title } = doc;
  const busy = doc.busy || doc.remote;
  const [query, setQuery] = useState("");
  const [staged, setStaged] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
    fetch("/api/ai/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConfigured(Boolean(d.configured)))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, busy]);

  // when a run finishes, refresh machine status (it probably changed something)
  const [wasBusy, setWasBusy] = useState(false);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) void refresh();
  }

  const entities = useMemo(() => entitiesFrom(vms, status), [vms, status]);
  const mentionNames = useMemo(() => new Set(entities.map((e) => e.name)), [entities]);

  const submit = (text: string) => {
    if ((!text && !staged.length) || busy) return;
    if (!items.length) setTitle(sid, (text || staged[0]?.name || "New session").slice(0, 70));
    const withFiles = staged.length ? `${text}\n\n${staged.map((f) => `[Attached: ${f.name} (id ${f.id}, ${fmtSize(f.size)})]`).join("\n")}` : text;
    updateItems(sid, (x) => [
      ...x.map((i) => (i.kind === "approval" && i.decision === undefined ? { ...i, decision: false } : i.kind === "question" && i.answer === undefined ? { ...i, answer: text } : i)),
      { kind: "user", text, files: staged.length ? staged : undefined },
    ]);
    setStaged([]);
    void send(sid, { message: withFiles + contextFor(text, vms, status), display: text, staged });
  };

  const decide = (id: string, ok: boolean) => {
    updateItems(sid, (x) => x.map((i) => (i.kind === "approval" && i.id === id ? { ...i, decision: ok } : i)));
    const next = currentDoc().items;
    if (!next.some((i) => i.kind === "approval" && i.decision === undefined)) {
      const approvals = Object.fromEntries(next.filter((i): i is Extract<Item, { kind: "approval" }> => i.kind === "approval" && i.decision !== undefined).map((i) => [i.id, Boolean(i.decision)]));
      void send(sid, { approvals });
    }
  };

  const answer = (id: string, text: string) => {
    updateItems(sid, (x) => x.map((i) => (i.kind === "question" && i.id === id ? { ...i, answer: text } : i)));
    void send(sid, { answers: { [id]: text } });
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        if (f.size > 3 * 1024 * 1024) throw new Error(`${f.name} is larger than 3 MB`);
        const data = await new Promise<string>((ok, fail) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result).split(",")[1] ?? "");
          r.onerror = () => fail(r.error);
          r.readAsDataURL(f);
        });
        const att = await api<Att>("/api/attachments", { session: sid, name: f.name || "pasted", type: f.type, data });
        setStaged((s) => [...s, att]);
        addFiles(sid, [att]);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  // ---- right panel ----
  const linkSet = new Set<string>();
  for (const i of items) {
    const t = i.kind === "text" ? i.text : i.kind === "step" ? (i.output ?? "") : "";
    for (const m of t.matchAll(URL_RE)) linkSet.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  const links = [...linkSet].filter((u) => !/\.git$/.test(u) && !/api\.github\.com/.test(u)).slice(-12);
  const lastText = [...items].reverse().find((i): i is Extract<Item, { kind: "text" }> => i.kind === "text");
  const suggestions = !busy && lastText ? splitSuggestions(lastText.text).suggestions : [];
  const machineSet = new Set<string>();
  for (const i of items) if (i.kind === "step") for (const v of vms) if (new RegExp(`\\b${v.name}\\b`).test(i.label + (i.shell?.vms.join(" ") ?? ""))) machineSet.add(v.name);
  const machines = [...machineSet];
  const stepCount = items.filter((i) => i.kind === "step").length;
  const shown = (st.list ?? []).filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

  // consecutive non-command steps collapse into "Ran N steps"; commands show as terminals
  const blocks: ({ kind: "steps"; steps: Extract<Item, { kind: "step" }>[]; key: string } | { kind: "one"; item: Item; key: string })[] = [];
  items.forEach((it, idx) => {
    const last = blocks[blocks.length - 1];
    if (it.kind === "step" && !it.shell) {
      if (last?.kind === "steps") last.steps.push(it);
      else blocks.push({ kind: "steps", steps: [it], key: `g${idx}` });
    } else blocks.push({ kind: "one", item: it, key: `i${idx}` });
  });
  const pendingQuestion = items.some((i) => i.kind === "question" && i.answer === undefined);
  const pendingApproval = items.some((i) => i.kind === "approval" && i.decision === undefined);

  return (
    <div className="flex h-[calc(100dvh-49px)]">
      {/* sessions */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/[0.06]">
        <div className="space-y-2 p-3">
          <button onClick={newSession} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-white hover:bg-white/5">
            <MessageSquarePlus className="size-4" /> New session
          </button>
          <label className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-1.5 text-sm text-muted">
            <Search className="size-3.5" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-white placeholder:text-muted focus:outline-none" />
          </label>
        </div>
        <p className="px-5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Recents</p>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {st.list === null ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
              <Loader2 className="size-3 animate-spin" /> Loading history from box5…
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">{query ? "No matches." : "Sessions you start show up here."}</p>
          ) : (
            shown.map((s) => {
              const live = st.docs[s.id]?.busy || st.docs[s.id]?.remote || s.running;
              return (
                <div key={s.id} className={cx("group flex items-center rounded-lg", s.id === sid ? "bg-white/[0.07]" : "hover:bg-white/[0.04]")}>
                  <button onClick={() => void openSession(s.id)} className="min-w-0 flex-1 px-3 py-2 text-left">
                    <p className="flex items-center gap-1.5 truncate text-sm text-white">
                      {live && <Loader2 className="size-3 shrink-0 animate-spin text-accent" />}
                      <span className="truncate">{s.title}</span>
                    </p>
                    <p className="text-[11px] text-muted">{live ? "working in the background" : timeAgo(s.updatedAt)}</p>
                  </button>
                  <button
                    onClick={() => confirm("Delete this session and its attachments?") && void removeSession(s.id)}
                    className="mr-2 hidden p-1 text-muted hover:text-[var(--critical-text)] group-hover:block"
                    aria-label="Delete session"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* conversation */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-3 px-8 py-8">
            {!configured && <p className="rounded-xl border border-white/10 p-4 text-sm text-ink">Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to enable the assistant.</p>}
            {items.length === 0 && configured && (
              <div className="pt-16">
                <p className="text-center text-2xl font-bold text-white">What should I do?</p>
                <p className="mt-2 text-center text-sm text-muted">
                  Type <kbd className="rounded bg-white/10 px-1 font-mono">/</kbd> for commands or <kbd className="rounded bg-white/10 px-1 font-mono">@</kbd> to tag a project, database or machine. It keeps working if you leave this page.
                </p>
                <div className="mt-8 grid grid-cols-2 gap-2">
                  {STARTERS.map((s) => (
                    <button key={s} onClick={() => submit(s)} className="rounded-xl border border-white/[0.08] bg-panel px-4 py-3 text-left text-sm text-zinc-200 hover:border-accent/60">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {blocks.map((b) =>
              b.kind === "steps" ? (
                <StepGroup key={b.key} steps={b.steps} />
              ) : (
                <Bubble key={b.key} item={b.item} busy={busy} onDecide={decide} onAnswer={answer} sessionId={sid} mentions={mentionNames} />
              ),
            )}

            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> {doc.remote ? "Working in the background…" : "Working…"}
              </p>
            )}
            {doc.paused && !busy && (
              <div className="flex items-center gap-3 text-sm text-muted">
                Paused to stay within the time limit.
                <Button size="sm" variant="primary" onClick={() => void send(sid, { message: "Continue." })}>
                  Continue
                </Button>
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => submit(s)} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-ink hover:border-accent/60">
                    {s}
                  </button>
                ))}
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-8 pb-6">
          <Composer
            entities={entities}
            busy={busy}
            disabled={!configured}
            uploading={uploading}
            staged={staged}
            review={st.review}
            placeholder={pendingQuestion ? "Type your own answer…" : pendingApproval ? "Approve or decline above, or type to change course…" : "Tell it what to do…  / for commands, @ to tag"}
            onSend={submit}
            onStop={() => void stop(sid)}
            onAttach={(f) => void upload(f)}
            onUnstage={(id) => setStaged((s) => s.filter((x) => x.id !== id))}
            onReview={setReview}
            onNew={newSession}
          />
          {(note || st.error) && <p className="mt-2 text-xs text-[var(--critical-text)]">{note || st.error}</p>}
        </div>
      </main>

      {/* context */}
      <aside className="scroll-thin w-80 shrink-0 space-y-6 overflow-y-auto border-l border-white/[0.06] p-5">
        <UnsplashLayer photo={photo} className="rounded-2xl ring-1 ring-white/10">
          <div className="px-4 pt-10 pb-4">
            <p className="text-[11px] font-bold tracking-[0.14em] text-ink/80 uppercase">Session</p>
            <p className="mt-1 line-clamp-2 text-base font-semibold text-white">{title}</p>
            <p className="mt-1 text-xs text-ink/70">
              {stepCount} step{stepCount === 1 ? "" : "s"} · {st.review === "manual" ? "review each step" : "auto"} · saved on box5
            </p>
          </div>
        </UnsplashLayer>

        <Section title="Links" icon={<Link2 className="size-3.5" />}>
          {links.length === 0 ? (
            <p className="text-xs text-muted">URLs it creates or finds show up here.</p>
          ) : (
            links.map((u) => (
              <div key={u} className="group flex items-center gap-1 rounded-md hover:bg-white/5">
                <a href={u} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-xs text-accent-soft">
                  <ArrowUpRight className="size-3 shrink-0" /> <span className="truncate">{u.replace(/^https?:\/\//, "").replace(/\?.*$/, "")}</span>
                </a>
                <CopyButton text={u} />
              </div>
            ))
          )}
        </Section>

        <Section title="Attachments" icon={<Paperclip className="size-3.5" />}>
          {files.length === 0 ? (
            <p className="text-xs text-muted">Files you attach or paste are stored on box5. The assistant can read them or place them on a machine.</p>
          ) : (
            files.map((f) => (
              <a key={f.id} href={`/api/attachments?session=${sid}&id=${f.id}`} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-ink hover:bg-white/5" title="Download">
                <FileText className="size-3.5 shrink-0 text-muted" /> <span className="flex-1 truncate">{f.name}</span>
                <span className="text-muted">{fmtSize(f.size)}</span>
              </a>
            ))
          )}
        </Section>

        <Section title="Suggestions" icon={<Sparkles className="size-3.5" />}>
          {(suggestions.length ? suggestions : items.length ? [] : STARTERS.slice(0, 2)).map((s) => (
            <button key={s} onClick={() => submit(s)} disabled={busy} className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/5 disabled:opacity-40">
              {s}
            </button>
          ))}
          {items.length > 0 && !suggestions.length && <p className="text-xs text-muted">Next steps appear when it finishes.</p>}
        </Section>

        <Section title="Machines" icon={<Server className="size-3.5" />}>
          {machines.length === 0 ? (
            <p className="text-xs text-muted">Machines it works on show up here.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {machines.map((m) => (
                <span key={m} className="rounded-md bg-accent/15 px-2 py-0.5 font-mono text-xs text-ink ring-1 ring-accent/40">
                  {m}
                </span>
              ))}
            </div>
          )}
        </Section>
      </aside>
    </div>
  );
}

function Section({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
          {icon} {title}
        </h3>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function StepGroup({ steps }: { steps: Extract<Item, { kind: "step" }>[] }) {
  const [open, setOpen] = useState(false);
  const running = steps.find((s) => s.running);
  const failed = steps.filter((s) => !s.running && s.ok === false).length;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex max-w-full items-center gap-2 py-1 text-sm text-muted hover:text-white">
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
}: {
  item: Item;
  busy: boolean;
  onDecide: (id: string, ok: boolean) => void;
  onAnswer: (id: string, text: string) => void;
  sessionId: string;
  mentions: Set<string>;
}) {
  if (item.kind === "user")
    return (
      <div className="flex flex-col items-end gap-1.5 pt-3">
        {item.text && (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.08] px-4 py-2.5 text-sm whitespace-pre-wrap text-white ring-1 ring-white/10">{inline(item.text, mentions)}</div>
        )}
        {item.files?.map((f) => (
          <a
            key={f.id}
            href={`/api/attachments?session=${sessionId}&id=${f.id}`}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-panel px-2.5 py-1 text-xs text-ink"
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
        <Markdown text={body} />
      </div>
    ) : null;
  }
  if (item.kind === "step" && item.shell) return <TerminalBlock shell={item.shell} output={item.output} running={item.running} ok={item.ok} />;
  if (item.kind === "diagram") return <FlowDiagram title={item.title} nodes={item.nodes} edges={item.edges} />;
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
