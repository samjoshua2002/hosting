"use client";

import {
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  Link2,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Search,
  SendHorizonal,
  Server,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCluster } from "@/components/cluster";
import { Markdown, inline } from "@/components/markdown";
import { UnsplashLayer, useTheme } from "@/components/theme";
import { Button, cx } from "@/components/ui";
import type { ChatMessage } from "@/lib/ai";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";

interface Att {
  id: string;
  name: string;
  size: number;
  type: string;
}
type Item =
  | { kind: "user"; text: string; files?: Att[] }
  | { kind: "text"; text: string }
  | { kind: "step"; id: string; label: string; running: boolean; ok?: boolean; output?: string }
  | { kind: "approval"; id: string; label: string; detail: string; decision?: boolean }
  | { kind: "question"; id: string; question: string; options: string[]; answer?: string };
type Ev =
  | { type: "text"; content: string }
  | { type: "tool"; id: string; label: string }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "approval"; id: string; label: string; detail: string }
  | { type: "question"; id: string; question: string; options: string[] }
  | { type: "done"; transcript: ChatMessage[]; waiting: boolean; paused: boolean };
interface Meta {
  id: string;
  title: string;
  updatedAt: number;
}

const CACHE = "hosting.operator.current";
const STARTERS = [
  "Check every machine and fix anything that looks wrong",
  "Show me what's running on each machine and how much room is left",
  "Deploy my repo github.com/<you>/<repo> to box2 with a public link",
  "Back up all databases on box5 into ~/backups with today's date",
];
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  const { vms, refresh } = useCluster();
  const { photo } = useTheme();
  const [sessions, setSessions] = useState<Meta[] | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState("New session");
  const [items, setItems] = useState<Item[]>([]);
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<Att[]>([]);
  const [staged, setStaged] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [configured, setConfigured] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const state = useRef({ sessionId, title, items, transcript, files });
  useEffect(() => {
    state.current = { sessionId, title, items, transcript, files };
  }, [sessionId, title, items, transcript, files]);

  const loadSessions = useCallback(async () => {
    try {
      const r = await api<{ sessions: Meta[] }>("/api/sessions");
      setSessions(r.sessions);
      setStoreError(null);
    } catch (e) {
      setSessions([]);
      setStoreError(`History lives on box5: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const c = JSON.parse(sessionStorage.getItem(CACHE) ?? "null");
        if (c?.items) {
          setSessionId(c.sessionId);
          setTitle(c.title);
          setItems((c.items as Item[]).map((i) => (i.kind === "step" ? { ...i, running: false } : i)));
          setTranscript(c.transcript ?? []);
          setFiles(c.files ?? []);
        }
      } catch {
        /* nothing cached */
      }
      void loadSessions();
    });
    fetch("/api/ai/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConfigured(Boolean(d.configured)))
      .catch(() => setConfigured(false));
  }, [loadSessions]);

  useEffect(() => {
    try {
      sessionStorage.setItem(CACHE, JSON.stringify({ sessionId, title, items, transcript, files }));
    } catch {
      /* full */
    }
  }, [sessionId, title, items, transcript, files]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, busy]);

  const persist = useCallback(async () => {
    const s = state.current;
    if (!s.sessionId || !s.items.length) return;
    try {
      await api("/api/sessions", { id: s.sessionId, title: s.title, items: s.items, transcript: s.transcript, attachments: s.files });
      void loadSessions();
    } catch (e) {
      setStoreError(`Couldn't save to box5: ${(e as Error).message}`);
    }
  }, [loadSessions]);

  const handle = (e: Ev) => {
    if (e.type === "text") setItems((x) => [...x, { kind: "text", text: e.content }]);
    else if (e.type === "tool") setItems((x) => [...x, { kind: "step", id: e.id, label: e.label, running: true }]);
    else if (e.type === "tool_result")
      setItems((x) =>
        x.some((i) => i.kind === "step" && i.id === e.id) ? x.map((i) => (i.kind === "step" && i.id === e.id ? { ...i, running: false, ok: e.ok, output: e.output } : i)) : x,
      );
    else if (e.type === "approval") setItems((x) => [...x, { kind: "approval", id: e.id, label: e.label, detail: e.detail }]);
    else if (e.type === "question") setItems((x) => [...x, { kind: "question", id: e.id, question: e.question, options: e.options }]);
    else if (e.type === "done") {
      setTranscript(e.transcript);
      state.current = { ...state.current, transcript: e.transcript };
      setPaused(e.paused);
    }
  };

  const send = async (body: { message?: string; approvals?: Record<string, boolean>; answers?: Record<string, string> }, sid: string) => {
    setBusy(true);
    setPaused(false);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: state.current.transcript, session: sid, ...body }),
        signal: ctrl.signal,
      });
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(JSON.parse(line) as Ev);
        }
        if (done) break;
      }
    } catch (e) {
      setItems((x) => [...x, { kind: "text", text: (e as Error).name === "AbortError" ? "Stopped." : `⚠️ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
      abort.current = null;
      setItems((x) => x.map((i) => (i.kind === "step" && i.running ? { ...i, running: false } : i)));
      setTimeout(() => void persist(), 50);
      void refresh();
    }
  };

  const ensureSession = () => {
    if (sessionId) return sessionId;
    const id = newId();
    setSessionId(id);
    state.current = { ...state.current, sessionId: id };
    return id;
  };

  const submit = (text = input) => {
    const msg = text.trim();
    if ((!msg && !staged.length) || busy) return;
    const sid = ensureSession();
    if (!items.length) {
      const t = (msg || staged[0]?.name || "New session").slice(0, 70);
      setTitle(t);
      state.current = { ...state.current, title: t };
    }
    const withFiles = staged.length ? `${msg}\n\n${staged.map((f) => `[Attached: ${f.name} (id ${f.id}, ${fmtSize(f.size)})]`).join("\n")}` : msg;
    setItems((x) => [
      ...x.map((i) =>
        i.kind === "approval" && i.decision === undefined ? { ...i, decision: false } : i.kind === "question" && i.answer === undefined ? { ...i, answer: msg } : i,
      ),
      { kind: "user", text: msg, files: staged.length ? staged : undefined },
    ]);
    setInput("");
    setStaged([]);
    void send({ message: withFiles }, sid);
  };

  const decide = (id: string, ok: boolean) => {
    const next = items.map((i) => (i.kind === "approval" && i.id === id ? { ...i, decision: ok } : i));
    setItems(next);
    if (!next.some((i) => i.kind === "approval" && i.decision === undefined) && sessionId) {
      const approvals = Object.fromEntries(
        next.filter((i): i is Extract<Item, { kind: "approval" }> => i.kind === "approval" && i.decision !== undefined).map((i) => [i.id, Boolean(i.decision)]),
      );
      void send({ approvals }, sessionId);
    }
  };

  const answer = (id: string, text: string) => {
    if (!sessionId) return;
    setItems((x) => x.map((i) => (i.kind === "question" && i.id === id ? { ...i, answer: text } : i)));
    void send({ answers: { [id]: text } }, sessionId);
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const sid = ensureSession();
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
        const att = await api<Att>("/api/attachments", { session: sid, name: f.name, type: f.type, data });
        setStaged((s) => [...s, att]);
        setFiles((s) => [...s, att]);
      }
    } catch (e) {
      setStoreError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const openSession = async (id: string) => {
    if (busy || id === sessionId) return;
    try {
      const s = await api<{ id: string; title: string; items: Item[]; transcript: ChatMessage[]; attachments: Att[] }>(`/api/sessions?id=${id}`);
      setSessionId(s.id);
      setTitle(s.title);
      setItems(s.items.map((i) => (i.kind === "step" ? { ...i, running: false } : i)));
      setTranscript(s.transcript);
      setFiles(s.attachments ?? []);
      setStaged([]);
      setPaused(false);
    } catch (e) {
      setStoreError((e as Error).message);
    }
  };

  const newSession = () => {
    if (busy) return;
    setSessionId(null);
    setTitle("New session");
    setItems([]);
    setTranscript([]);
    setFiles([]);
    setStaged([]);
    setPaused(false);
  };

  const removeSession = async (id: string) => {
    if (!confirm("Delete this session and its attachments?")) return;
    await api(`/api/sessions?id=${id}`, undefined, { method: "DELETE" }).catch(() => {});
    if (id === sessionId) newSession();
    void loadSessions();
  };

  // ---- what the right panel shows ----
  const links = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      const t = i.kind === "text" ? i.text : i.kind === "step" ? (i.output ?? "") : "";
      for (const m of t.matchAll(URL_RE)) set.add(m[0].replace(/[.,;:!?]+$/, ""));
    }
    return [...set].filter((u) => !/\.git$/.test(u)).slice(-12);
  }, [items]);
  const lastText = [...items].reverse().find((i): i is Extract<Item, { kind: "text" }> => i.kind === "text");
  const suggestions = !busy && lastText ? splitSuggestions(lastText.text).suggestions : [];
  const machines = useMemo(() => {
    const names = new Set<string>();
    for (const i of items) if (i.kind === "step") for (const v of vms) if (new RegExp(`\\b${v.name}\\b`).test(i.label)) names.add(v.name);
    return [...names];
  }, [items, vms]);
  const stepCount = items.filter((i) => i.kind === "step").length;
  const shown = (sessions ?? []).filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

  // consecutive steps collapse into one "Ran N steps" block
  const blocks: ({ kind: "steps"; steps: Extract<Item, { kind: "step" }>[]; key: string } | { kind: "one"; item: Item; key: string })[] = [];
  items.forEach((it, idx) => {
    const last = blocks[blocks.length - 1];
    if (it.kind === "step") {
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
          <button onClick={newSession} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-white hover:bg-white/5 disabled:opacity-40">
            <MessageSquarePlus className="size-4" /> New session
          </button>
          <label className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-1.5 text-sm text-muted">
            <Search className="size-3.5" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-white placeholder:text-muted focus:outline-none" />
          </label>
        </div>
        <p className="px-5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Recents</p>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions === null ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
              <Loader2 className="size-3 animate-spin" /> Loading history from box5…
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">{query ? "No matches." : "Sessions you start show up here."}</p>
          ) : (
            shown.map((s) => (
              <div key={s.id} className={cx("group flex items-center rounded-lg", s.id === sessionId ? "bg-white/[0.07]" : "hover:bg-white/[0.04]")}>
                <button onClick={() => openSession(s.id)} className="min-w-0 flex-1 px-3 py-2 text-left">
                  <p className="truncate text-sm text-white">{s.title}</p>
                  <p className="text-[11px] text-muted">{timeAgo(s.updatedAt)}</p>
                </button>
                <button onClick={() => removeSession(s.id)} className="mr-2 hidden p-1 text-muted hover:text-[var(--critical-text)] group-hover:block" aria-label="Delete session">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))
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
                <p className="mt-2 text-center text-sm text-muted">It runs commands, deploys, checks the result and keeps going. Attach files with the clip.</p>
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
                <Bubble key={b.key} item={b.item} busy={busy} onDecide={decide} onAnswer={answer} sessionId={sessionId} />
              ),
            )}

            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Working…
              </p>
            )}
            {paused && !busy && (
              <div className="flex items-center gap-3 text-sm text-muted">
                Paused to stay within the time limit.
                <Button size="sm" variant="primary" onClick={() => sessionId && void send({ message: "Continue." }, sessionId)}>
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
          {staged.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {staged.map((f) => (
                <span key={f.id} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-panel px-2 py-1 text-xs text-ink">
                  <FileText className="size-3.5" /> {f.name} <span className="text-muted">{fmtSize(f.size)}</span>
                  <button onClick={() => setStaged((s) => s.filter((x) => x.id !== f.id))} className="text-muted hover:text-white" aria-label="Remove">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex items-end gap-2 rounded-2xl border border-white/[0.1] bg-panel p-2 shadow-xl"
          >
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="grid size-10 shrink-0 place-items-center rounded-xl text-muted hover:bg-white/5 hover:text-white"
              aria-label="Attach files"
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={pendingQuestion ? "Type your own answer…" : pendingApproval ? "Approve or decline above, or type to change course…" : "Tell it what to do… (Enter to send)"}
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm text-white placeholder:text-muted focus:outline-none"
            />
            {busy ? (
              <Button type="button" variant="danger" onClick={() => abort.current?.abort()}>
                <Square className="size-3.5" /> Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={(!input.trim() && !staged.length) || !configured}>
                <SendHorizonal className="size-4" />
              </Button>
            )}
          </form>
          {storeError && <p className="mt-2 text-xs text-[var(--critical-text)]">{storeError}</p>}
        </div>
      </main>

      {/* context */}
      <aside className="scroll-thin w-80 shrink-0 space-y-6 overflow-y-auto border-l border-white/[0.06] p-5">
        <UnsplashLayer photo={photo} className="rounded-2xl ring-1 ring-white/10">
          <div className="px-4 pt-10 pb-4">
            <p className="text-[11px] font-bold tracking-[0.14em] text-ink/80 uppercase">Session</p>
            <p className="mt-1 line-clamp-2 text-base font-semibold text-white">{title}</p>
            <p className="mt-1 text-xs text-ink/70">
              {stepCount} step{stepCount === 1 ? "" : "s"} · saved on box5
            </p>
          </div>
        </UnsplashLayer>

        <Section title="Links" icon={<Link2 className="size-3.5" />}>
          {links.length === 0 ? (
            <p className="text-xs text-muted">URLs it creates or finds show up here.</p>
          ) : (
            links.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate rounded-md px-2 py-1 text-xs text-accent-soft hover:bg-white/5">
                <ArrowUpRight className="size-3 shrink-0" /> <span className="truncate">{u.replace(/^https?:\/\//, "").replace(/\?.*$/, "")}</span>
              </a>
            ))
          )}
        </Section>

        <Section
          title="Attachments"
          icon={<Paperclip className="size-3.5" />}
          action={
            <button onClick={() => fileInput.current?.click()} className="text-xs text-accent-soft hover:text-white">
              + Add
            </button>
          }
        >
          {files.length === 0 ? (
            <p className="text-xs text-muted">Files you attach are stored on box5. The assistant can read them or place them on a machine.</p>
          ) : (
            files.map((f) => (
              <a
                key={f.id}
                href={sessionId ? `/api/attachments?session=${sessionId}&id=${f.id}` : undefined}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-ink hover:bg-white/5"
                title="Download"
              >
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
}: {
  item: Item;
  busy: boolean;
  onDecide: (id: string, ok: boolean) => void;
  onAnswer: (id: string, text: string) => void;
  sessionId: string | null;
}) {
  if (item.kind === "user")
    return (
      <div className="flex flex-col items-end gap-1.5 pt-3">
        {item.text && <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white px-4 py-2.5 text-sm whitespace-pre-wrap text-[#0b0e1c]">{item.text}</div>}
        {item.files?.map((f) => (
          <a
            key={f.id}
            href={sessionId ? `/api/attachments?session=${sessionId}&id=${f.id}` : undefined}
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
          <ShieldAlert className="size-4 shrink-0 text-[var(--warning)]" /> Needs your OK
        </p>
        <p className="mt-1 text-sm text-ink/85">{inline(item.label)}</p>
        {item.detail && <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] text-ink">{item.detail}</pre>}
        {item.decision === undefined ? (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => onDecide(item.id, true)} disabled={busy}>
              <Check className="size-3.5" /> Approve
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
