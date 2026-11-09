"use client";

import Link from "next/link";

import { LOCAL_URL, useNiceLink } from "@/components/nice-links";

import { Activity, ArrowDown, ArrowUpRight, Cpu, FolderOpen, Globe, Hash, MessagesSquare, MoreHorizontal, Settings, Camera, FileText, GitBranch, Layers, Link2, ListChecks, Loader2, MessageSquarePlus, Paperclip, Pencil, Pin, PinOff, Search, Server, ShieldCheck, Sparkles, Trash2, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { addFiles, currentDoc, editSession, hydrate, newSession, openSession, removeSession, send, setModel, setReview, setTitle, stop, updateItems, useAssistant, type Meta } from "@/components/assistant-store";
import { ArtifactView } from "@/components/artifact-view";
import { Monitor } from "@/components/assistant-panel";
import { AttachmentView } from "@/components/attachment-view";
import { ChatItems, PlanCard } from "@/components/chat-items";
import { CopyButton } from "@/components/chat-blocks";
import { useCluster } from "@/components/cluster";
import { Composer, contextFor, entitiesFrom, type ModelChoice } from "@/components/composer";
import { Button, cx } from "@/components/ui";
import { latestArtifacts, type Att, type Item } from "@/lib/assistant-items";
import { api, useStored } from "@/lib/client";
import { timeAgo } from "@/lib/format";

const STARTERS = [
  "Check every machine and fix anything that looks wrong",
  "Explain the pipeline of my projects with a diagram",
  "List the tables in my databases with row counts",
  "Show my GitHub repos that aren't deployed yet",
];
/** Quick mask for the chat bubble: KEY=value lines and well-known credential shapes. */
function hideSecrets(t: string): string {
  return t
    .replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*).{3,}$/gm, "$1••••")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, "••••")
    .replace(/(:\/\/[^\s:@/]+:)[^\s@/]+@/g, "$1••••@");
}

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


/** A file in the chat box: uploading (pending, pct), ready, or failed; images carry a local preview. */
type PanelId = "outputs" | "links" | "files" | "monitor";
const PANELS: [PanelId, string, typeof Layers][] = [
  ["outputs", "Outputs", ListChecks],
  ["links", "Links", Globe],
  ["files", "Files", FolderOpen],
  ["monitor", "Machines & jobs", Activity],
];

export type Staged = Att & { pending?: boolean; pct?: number; preview?: string; error?: string };

export default function AssistantPage() {
  const { vms, status, refresh, reloadVms } = useCluster();
  const st = useAssistant();
  const doc = currentDoc(st);
  const sid = st.current;
  const { items, files, title } = doc;
  const busy = doc.busy || doc.remote;
  const [query, setQuery] = useState("");
  const [staged, setStaged] = useState<Staged[]>([]);
  const [uploading, setUploading] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [art, setArtRaw] = useState<string | null>(null);
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  // one side view at a time: an artifact or a file preview
  const setArt = (id: string | null) => {
    setArtRaw(id);
    if (id) setFile(null);
  };
  const openFile = (f: { id: string; name: string } | null) => {
    setFile(f);
    if (f) setArtRaw(null);
  };
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
    fetch("/api/ai/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { configured: boolean; models?: { id: string; model: string }[]; agent?: string; local?: { id: string; model: string; vm: string; service: string; sizeGb: number }[] }) => {
        setConfigured(Boolean(d.configured) || Boolean(d.local?.length));
        const cloud: ModelChoice[] = d.configured
          ? [
              { id: "", label: d.agent ?? "Default", sub: "default · runs commands, deploys, fixes", local: false },
              ...(d.models ?? []).filter((m) => m.id !== d.agent).map((m) => ({ id: m.id, label: m.id, sub: m.model, local: false })),
            ]
          : [];
        const local: ModelChoice[] = (d.local ?? []).map((m) => ({ id: m.id, label: m.model, sub: `${m.service} on ${m.vm} · ${m.sizeGb} GB`, local: true }));
        setModels([...cloud, ...local]);
      })
      .catch(() => setConfigured(false));
  }, []);

  // Follow new messages only while the reader is at the bottom; otherwise show a "new messages" button.
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setAtBottom(near);
    if (near) setUnseen(false);
  };
  const toBottom = (smooth = true) => {
    bottom.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
    setUnseen(false);
  };
  const lastLen = useRef(0);
  useEffect(() => {
    const grew = items.length > lastLen.current;
    const mine = items[items.length - 1]?.kind === "user";
    lastLen.current = items.length;
    // after paint: the new message is in the DOM, so scrolling (or flagging it) is accurate
    if (atBottom || mine) requestAnimationFrame(() => toBottom());
    else if (grew) requestAnimationFrame(() => setUnseen(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, busy]);
  // a new session or switching sessions starts at the latest message
  useEffect(() => {
    lastLen.current = 0;
    requestAnimationFrame(() => {
      setAtBottom(true);
      toBottom(false);
    });
  }, [sid]);

  // when a run finishes, refresh machine status (it probably changed something)
  const [wasBusy, setWasBusy] = useState(false);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) {
      void refresh();
    }
  }

  const entities = useMemo(() => entitiesFrom(vms, status), [vms, status]);
  const mentionNames = useMemo(() => new Set(entities.map((e) => e.name)), [entities]);

  const submit = async (raw: string) => {
    if (staged.some((f) => f.pending)) return; // Send is off until every file is stored
    const ready = staged.filter((f) => !f.pending && !f.error).map(({ id, name, size, type }) => ({ id, name, size, type }));
    if ((!raw && !ready.length) || busy) return;
    // machine tokens never go to the AI: the dashboard adds the machine itself, and every copy is hidden
    let text = raw;
    if (/ibssh_[A-Za-z0-9]{4,}/.test(raw)) {
      setNote("Adding the machine…");
      let outcome: string;
      try {
        // the server picks the token and an optional "box6" / "call it box6" out of the message
        const r = await api<{ name: string; summary: string[] }>("/api/machines", { ssh: raw });
        outcome = `[machine added as ${r.name}: ${r.summary.join("; ")}]`;
        void reloadVms();
      } catch (e) {
        outcome = `[the dashboard couldn't add this machine: ${(e as Error).message}]`;
      }
      setNote(null);
      text = `${raw.replace(/ibssh_[A-Za-z0-9]{4,}/g, "ibssh_••••(hidden)")}\n\n${outcome}`;
    }
    if (!items.length) setTitle(sid, (text || ready[0]?.name || "New session").slice(0, 70));
    const withFiles = ready.length ? `${text}\n\n${ready.map((f) => `[Attached: ${f.name} (id ${f.id}, ${fmtSize(f.size)})]`).join("\n")}` : text;
    updateItems(sid, (x) => [
      ...x.map((i) => (i.kind === "approval" && i.decision === undefined ? { ...i, decision: false } : i.kind === "question" && i.answer === undefined ? { ...i, answer: text } : i)),
      // secrets never show, even for the moment before the server answers
      { kind: "user", text: hideSecrets(text), files: ready.length ? ready : undefined },
    ]);
    for (const f of staged) if (f.preview) URL.revokeObjectURL(f.preview);
    setStaged([]);
    void send(sid, { message: withFiles + contextFor(text, vms, status), display: text, staged: ready });
  };

  // Each file shows at once (image preview or file chip), dimmed with its own progress until it's stored;
  // Send stays off until every file is ready.
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = Array.from(list);
    const temps = files.map((f) => ({
      id: `up-${Math.random().toString(36).slice(2, 10)}`,
      name: f.name || "pasted",
      size: f.size,
      type: f.type,
      pending: true,
      pct: 0,
      preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
    }));
    setStaged((s) => [...s, ...temps]);
    setUploading(true);
    const patch = (id: string, p: Partial<Staged>) => setStaged((s) => s.map((x) => (x.id === id ? { ...x, ...p } : x)));
    const CHUNK = 2_500_000; // under Vercel's request limit; bigger files go in pieces
    const b64 = (blob: Blob) =>
      new Promise<string>((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(",")[1] ?? "");
        r.onerror = () => fail(r.error);
        r.readAsDataURL(blob);
      });
    await Promise.all(
      files.map(async (f, n) => {
        const t = temps[n];
        try {
          if (f.size > 50 * 1024 * 1024) throw new Error("larger than 50 MB");
          let att: Att;
          if (f.size <= CHUNK) {
            patch(t.id, { pct: 40 });
            att = await api<Att>("/api/attachments", { session: sid, name: t.name, type: f.type, data: await b64(f) });
          } else {
            const upload = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
            const parts = Math.ceil(f.size / CHUNK);
            for (let i = 0; i < parts; i++) {
              await api("/api/attachments", { session: sid, upload, index: i, data: await b64(f.slice(i * CHUNK, (i + 1) * CHUNK)) });
              patch(t.id, { pct: Math.round(((i + 1) / parts) * 92) });
            }
            att = await api<Att>("/api/attachments", { session: sid, upload, finish: true, parts, size: f.size, name: t.name, type: f.type });
          }
          // keep the local preview: the stored file is the same picture
          setStaged((s) => s.map((x) => (x.id === t.id ? { ...att, preview: t.preview } : x)));
          addFiles(sid, [att]);
        } catch (e) {
          patch(t.id, { pending: false, error: (e as Error).message });
        }
      }),
    );
    setUploading(false);
  };

  // ---- right panel ----
  const [panel, setPanel] = useStored<PanelId | null>("hosting.assistant.panel", null);
  const [infoOpen, setInfoOpen] = useState(false);
  const shots = items
    .filter((i): i is Extract<Item, { kind: "image" }> => i.kind === "image")
    .map((i) => ({ ...i, fileId: /[?&]id=([a-z0-9]+)/.exec(i.src)?.[1] }))
    .reverse();
  const repos = [...new Set(items.flatMap((i) => (i.kind === "text" ? i.text : i.kind === "step" ? `${i.label} ${i.output ?? ""}` : "").match(/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/g) ?? []).map((u) => u.replace(/^github\.com\//, "").replace(/\.git$/, "")))].slice(0, 8);
  const plan = [...items].reverse().find((i): i is Extract<Item, { kind: "plan" }> => i.kind === "plan");
  const nice = useNiceLink();
  const linkSet = new Set<string>();
  for (const i of items) {
    const t = i.kind === "text" ? i.text : i.kind === "step" ? (i.output ?? "") : "";
    for (const m of t.matchAll(URL_RE)) linkSet.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  const links = [...new Set([...linkSet].filter((u) => !/\.git$/.test(u) && !/api\.github\.com/.test(u) && !LOCAL_URL.test(u)).map(nice))].slice(-12);
  const lastText = [...items].reverse().find((i): i is Extract<Item, { kind: "text" }> => i.kind === "text");
  const suggestions = !busy && lastText ? splitSuggestions(lastText.text).suggestions : [];
  const machineSet = new Set<string>();
  for (const i of items) if (i.kind === "step") for (const v of vms) if (new RegExp(`\\b${v.name}\\b`).test(i.label + (i.shell?.vms.join(" ") ?? ""))) machineSet.add(v.name);
  const machines = [...machineSet];
  const stepCount = items.filter((i) => i.kind === "step").length;
  const artifacts = latestArtifacts(items);
  const outputCount = artifacts.length + shots.length;
  const artVersions = items.filter((i): i is Extract<Item, { kind: "artifact" }> => i.kind === "artifact" && i.id === art);
  const shown = (st.list ?? []).filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

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
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {st.list === null ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
              <Loader2 className="size-3 animate-spin" /> Loading history from box5…
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">{query ? "No matches." : "Sessions you start show up here."}</p>
          ) : (
            <>
              {shown.some((x) => x.pinned) && <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Pinned</p>}
              {shown
                .filter((x) => x.pinned)
                .map((x) => (
                  <SessionRow key={x.id} s={x} active={x.id === sid} live={Boolean(st.docs[x.id]?.busy || st.docs[x.id]?.remote || x.running)} />
                ))}
              <p className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Recents</p>
              {shown
                .filter((x) => !x.pinned)
                .map((x) => (
                  <SessionRow key={x.id} s={x} active={x.id === sid} live={Boolean(st.docs[x.id]?.busy || st.docs[x.id]?.remote || x.running)} />
                ))}
            </>
          )}
        </div>
      </aside>

      {/* conversation */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.05] px-4">
          <p className="min-w-0 flex-1 truncate text-[13px] text-zinc-300">{items.length ? title : "New conversation"}</p>
          {PANELS.map(([id, label, Icon]) => {
            const count = id === "outputs" ? outputCount : id === "links" ? links.length : id === "files" ? files.length : 0;
            const on = panel === id && !art && !file;
            return (
              <button
                key={id}
                onClick={() => {
                  setArt(null);
                  openFile(null);
                  setPanel(on ? null : id);
                }}
                title={label}
                aria-label={label}
                aria-pressed={on}
                className={cx("relative grid size-8 place-items-center rounded-md transition-colors", on ? "bg-white/[0.09] text-white" : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200")}
              >
                <Icon className="size-[17px]" strokeWidth={1.75} />
                {count > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--accent)]" />}
              </button>
            );
          })}
          <div className="relative">
            <button
              onClick={() => setInfoOpen((o) => !o)}
              title="Environment and context"
              aria-label="Environment and context"
              aria-expanded={infoOpen}
              className={cx("grid size-8 place-items-center rounded-md transition-colors", infoOpen ? "bg-white/[0.09] text-white" : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200")}
            >
              <MoreHorizontal className="size-[17px]" />
            </button>
            {infoOpen && (
              <>
                <button className="fixed inset-0 z-30 cursor-default" aria-label="Close" onClick={() => setInfoOpen(false)} />
                <div className="absolute top-10 right-0 z-40 w-80 rounded-xl border border-white/[0.08] bg-[#141416] p-3 shadow-2xl shadow-black/60">
                  <p className="px-1 pb-1.5 text-[11px] font-medium text-zinc-500">Environment</p>
                  <InfoRow icon={Cpu} label="Model" value={st.model || "default (best available)"} />
                  <InfoRow icon={ShieldCheck} label="Review" value={st.review === "manual" ? "you approve every step" : "auto · risky steps ask first"} />
                  <InfoRow icon={Server} label="Machines" value={machines.length ? machines.join(", ") : "none yet"} />
                  {repos.map((r) => (
                    <InfoRow key={r} icon={GitBranch} label="Repository" value={r} href={`https://github.com/${r}`} />
                  ))}
                  <div className="my-2 border-t border-white/[0.06]" />
                  <p className="px-1 pb-1.5 text-[11px] font-medium text-zinc-500">Context</p>
                  <InfoRow icon={MessagesSquare} label="Messages" value={`${items.filter((i) => i.kind === "user").length} from you · ${stepCount} steps`} />
                  <InfoRow icon={Paperclip} label="Files" value={`${files.length}`} />
                  <InfoRow icon={Layers} label="Outputs" value={`${artifacts.length} artifacts · ${shots.length} screenshots`} />
                  <InfoRow icon={Hash} label="Session" value={sid} mono />
                  <div className="my-2 border-t border-white/[0.06]" />
                  <Link href="/settings" className="flex items-center gap-2 rounded-md px-1 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.05] hover:text-white">
                    <Settings className="size-3.5 text-zinc-500" /> Connectors, instructions, memory and skills
                    <ArrowUpRight className="ml-auto size-3.5 text-zinc-500" />
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
        <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
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
                    <button key={s} onClick={() => void submit(s)} className="rounded-xl border border-white/[0.08] bg-panel px-4 py-3 text-left text-sm text-zinc-200 hover:border-accent/60">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <ChatItems sid={sid} items={items} busy={busy} mentions={mentionNames} onOpenArtifact={setArt} onOpenFile={openFile} />

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
                  <button key={s} onClick={() => void submit(s)} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-ink hover:border-accent/60">
                    {s}
                  </button>
                ))}
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-3xl px-8 pb-6">
          {!atBottom && (
            <button
              onClick={() => toBottom()}
              className={cx(
                "absolute -top-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs shadow-lg shadow-black/40 backdrop-blur transition-colors",
                unseen ? "border-[var(--accent)]/50 bg-[var(--accent)] text-[var(--accent-ink)]" : "border-white/10 bg-panel/90 text-zinc-300 hover:text-white",
              )}
            >
              <ArrowDown className="size-3.5" /> {unseen ? "New messages" : "Latest"}
            </button>
          )}
          <Composer
            entities={entities}
            busy={busy}
            disabled={!configured}
            uploading={uploading}
            staged={staged}
            review={st.review}
            placeholder={pendingQuestion ? "Type your own answer…" : pendingApproval ? "Approve or decline above, or type to change course…" : "Ask anything, @ to mention, / for actions"}
            onSend={(t) => void submit(t)}
            onStop={() => void stop(sid)}
            onAttach={(f) => void upload(f)}
            onUnstage={(id) => setStaged((s) => s.filter((x) => x.id !== id))}
            onReview={setReview}
            onNew={newSession}
            models={models}
            model={st.model}
            onModel={setModel}
          />
          {(note || st.error) && <p className="mt-2 text-xs text-[var(--critical-text)]">{note || st.error}</p>}
        </div>
      </main>

      {file ? (
        <aside className="w-[min(760px,48%)] shrink-0 border-l border-white/[0.06] bg-panel/60">
          <AttachmentView key={file.id} session={sid} id={file.id} name={file.name} onClose={() => openFile(null)} />
        </aside>
      ) : art && artVersions.length > 0 ? (
        <aside className="w-[min(760px,48%)] shrink-0 border-l border-white/[0.06] bg-panel/60">
          <ArtifactView key={`${art}-${artVersions.length}`} versions={artVersions} onClose={() => setArt(null)} />
        </aside>
      ) : panel ? (
      <aside className="flex w-[360px] shrink-0 flex-col border-l border-white/[0.06] bg-[#0b0b0d]">
        <div className="flex h-11 items-center gap-2 border-b border-white/[0.06] px-4">
          <p className="flex-1 text-[13px] font-medium text-white">{PANELS.find((x) => x[0] === panel)?.[1]}</p>
          <button onClick={() => setPanel(null)} className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white" aria-label="Close panel">
            <X className="size-4" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {panel === "outputs" && (
          <>
            {plan && (
              <Section title="Progress" icon={<ListChecks className="size-3.5" />}>
                <PlanCard plan={plan} compact />
              </Section>
            )}
            <Section title="Artifacts" icon={<Layers className="size-3.5" />}>
              {artifacts.length === 0 ? (
                <p className="text-xs text-muted">Reports, designs, scripts and pages it makes open here.</p>
              ) : (
                artifacts.map((x) => (
                  <button key={x.id} onClick={() => setArt(x.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/5">
                    <FileText className="size-3.5 shrink-0 text-muted" />
                    <span className="flex-1 truncate">{x.title}</span>
                    <span className="text-[10px] uppercase text-zinc-600">{x.type}</span>
                    {x.version > 1 && <span className="text-muted">v{x.version}</span>}
                  </button>
                ))
              )}
            </Section>
            {shots.length > 0 && (
              <Section title="Screenshots" icon={<Camera className="size-3.5" />}>
                <div className="grid grid-cols-2 gap-1.5">
                  {shots.map((x) => (
                    <button key={x.id} onClick={() => x.fileId && openFile({ id: x.fileId, name: x.title })} className="group overflow-hidden rounded-md border border-white/[0.08] text-left" title={x.title}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={x.src} alt={x.title} className="aspect-video w-full object-cover object-top transition-opacity group-hover:opacity-80" loading="lazy" />
                      <span className="block truncate px-1.5 py-1 text-[10px] text-zinc-400">{(x.url ?? x.title).replace(/^https?:\/\//, "")}</span>
                    </button>
                  ))}
                </div>
              </Section>
            )}
        <Section title="Suggestions" icon={<Sparkles className="size-3.5" />}>
          {(suggestions.length ? suggestions : items.length ? [] : STARTERS.slice(0, 2)).map((s) => (
            <button key={s} onClick={() => void submit(s)} disabled={busy} className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/5 disabled:opacity-40">
              {s}
            </button>
          ))}
          {items.length > 0 && !suggestions.length && <p className="text-xs text-muted">Next steps appear when it finishes.</p>}
        </Section>
          </>
        )}
        {panel === "links" && (
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
        )}
        {panel === "files" && (
        <Section title="Files" icon={<Paperclip className="size-3.5" />}>
          {files.length === 0 ? (
            <p className="text-xs text-muted">Files you attach show up here; click one to preview it.</p>
          ) : (
            files.map((f) => (
              <button key={f.id} onClick={() => openFile({ id: f.id, name: f.name })} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink hover:bg-white/5" title="Preview">
                <FileText className="size-3.5 shrink-0 text-muted" /> <span className="flex-1 truncate">{f.name}</span>
                <span className="text-muted">{fmtSize(f.size)}</span>
              </button>
            ))
          )}
        </Section>
        )}
        {panel === "monitor" && <Monitor />}
        </div>
      </aside>
      ) : null}
    </div>
  );
}

function InfoRow({ icon: Icon, label, value, href, mono }: { icon: typeof Layers; label: string; value: string; href?: string; mono?: boolean }) {
  const body = (
    <>
      <Icon className="size-3.5 shrink-0 text-zinc-500" />
      <span className="w-20 shrink-0 text-zinc-500">{label}</span>
      <span className={cx("min-w-0 flex-1 truncate text-right", mono ? "font-mono text-[11px] text-zinc-400" : "text-zinc-200", href && "text-accent-soft")}>{value}</span>
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-white/[0.04]">
      {body}
    </a>
  ) : (
    <div className="flex items-center gap-2 px-1 py-1 text-xs">{body}</div>
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


function SessionRow({ s, active, live }: { s: Meta; active: boolean; live: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.title);
  const save = () => {
    setEditing(false);
    const t = name.trim();
    if (t && t !== s.title) void editSession(s.id, { title: t });
    else setName(s.title);
  };
  return (
    <div className={cx("group flex items-center rounded-lg", active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]")}>
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setName(s.title);
              setEditing(false);
            }
          }}
          className="m-1 min-w-0 flex-1 rounded-md border border-accent/60 bg-transparent px-2 py-1.5 text-sm text-white outline-none"
        />
      ) : (
        <button onClick={() => void openSession(s.id)} onDoubleClick={() => setEditing(true)} className="min-w-0 flex-1 px-3 py-2 text-left">
          <p className="flex items-center gap-1.5 truncate text-sm text-white">
            {live ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
            ) : s.source === "pipeline" ? (
              <Workflow className="size-3 shrink-0 text-muted" />
            ) : s.source === "autopilot" ? (
              <ShieldCheck className="size-3 shrink-0 text-accent-soft" />
            ) : null}
            <span className="truncate">{s.title}</span>
          </p>
          <p className="text-[11px] text-muted">{live ? "working in the background" : `${s.source === "pipeline" ? "from Pipeline · " : s.source === "autopilot" ? "Autopilot · " : ""}${timeAgo(s.updatedAt)}`}</p>
        </button>
      )}
      {!editing && (
        <div className="mr-1.5 hidden items-center group-hover:flex">
          <button onClick={() => void editSession(s.id, { pinned: !s.pinned })} className="rounded p-1 text-muted hover:text-white" title={s.pinned ? "Unpin" : "Pin"} aria-label={s.pinned ? "Unpin" : "Pin"}>
            {s.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
          <button onClick={() => setEditing(true)} className="rounded p-1 text-muted hover:text-white" title="Rename" aria-label="Rename">
            <Pencil className="size-3.5" />
          </button>
          <button onClick={() => confirm("Delete this session and its attachments?") && void removeSession(s.id)} className="rounded p-1 text-muted hover:text-[var(--critical-text)]" title="Delete" aria-label="Delete session">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
