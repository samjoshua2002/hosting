"use client";

import { Check, ChevronRight, Loader2, MessagesSquare, Play, RotateCcw, SendHorizonal, ShieldAlert, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCluster } from "@/components/cluster";
import { Markdown, inline } from "@/components/markdown";
import { UnsplashLayer, useTheme } from "@/components/theme";
import { Button, Card, cx } from "@/components/ui";
import type { ChatMessage } from "@/lib/ai";

type Item =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "step"; id: string; label: string; running: boolean; ok?: boolean; output?: string }
  | { kind: "approval"; id: string; label: string; detail: string; decision?: boolean };

type Event =
  | { type: "text"; content: string }
  | { type: "tool"; id: string; label: string }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "approval"; id: string; label: string; detail: string }
  | { type: "done"; transcript: ChatMessage[]; waiting: boolean; paused: boolean };

const STORE = "hosting.operator";

const STARTERS = [
  "Make box5 the database machine: run PostgreSQL, MySQL, MongoDB and Redis there with strong passwords, and connect every other machine to them",
  "Check every machine and fix anything that looks wrong",
  "Deploy https://github.com/vercel/next.js/tree/canary/examples/hello-world as a project on box2 with a public link",
  "Free up disk space on all machines and tell me how much you saved",
];

export default function AssistantPage() {
  const { refresh } = useCluster();
  const { photo } = useTheme();
  const [items, setItems] = useState<Item[]>([]);
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [configured, setConfigured] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // restore the conversation after a refresh (deferred: storage is only readable after mount)
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(STORE) ?? "null");
        if (saved?.items) {
          setItems((saved.items as Item[]).map((i) => (i.kind === "step" ? { ...i, running: false } : i)));
          setTranscript(saved.transcript ?? []);
        }
      } catch {
        /* nothing saved */
      }
    });
    fetch("/api/ai/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConfigured(Boolean(d.configured)))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify({ items, transcript }));
    } catch {
      /* storage full or unavailable */
    }
  }, [items, transcript]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, busy]);

  const pending = items.filter((i): i is Extract<Item, { kind: "approval" }> => i.kind === "approval" && i.decision === undefined);

  const send = async (body: { message?: string; approvals?: Record<string, boolean> }) => {
    setBusy(true);
    setPaused(false);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, ...body }),
        signal: ctrl.signal,
      });
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(JSON.parse(line) as Event);
        }
        if (done) break;
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setItems((x) => [...x, { kind: "text", text: `⚠️ ${(e as Error).message}` }]);
      else setItems((x) => [...x, { kind: "text", text: "Stopped." }]);
    } finally {
      setBusy(false);
      abort.current = null;
      setItems((x) => x.map((i) => (i.kind === "step" && i.running ? { ...i, running: false } : i)));
      void refresh();
    }
  };

  const handle = (e: Event) => {
    if (e.type === "text") setItems((x) => [...x, { kind: "text", text: e.content }]);
    else if (e.type === "tool") setItems((x) => [...x, { kind: "step", id: e.id, label: e.label, running: true }]);
    else if (e.type === "tool_result")
      setItems((x) => {
        const has = x.some((i) => i.kind === "step" && i.id === e.id);
        return has
          ? x.map((i) => (i.kind === "step" && i.id === e.id ? { ...i, running: false, ok: e.ok, output: e.output } : i))
          : [...x, { kind: "step", id: e.id, label: e.output === "declined" ? "Declined" : "Action", running: false, ok: e.ok, output: e.output }];
      });
    else if (e.type === "approval") setItems((x) => [...x, { kind: "approval", id: e.id, label: e.label, detail: e.detail }]);
    else if (e.type === "done") {
      setTranscript(e.transcript);
      setPaused(e.paused);
    }
  };

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    // answering while an approval is open counts as declining it
    setItems((x) => [...x.map((i) => (i.kind === "approval" && i.decision === undefined ? { ...i, decision: false } : i)), { kind: "user", text }]);
    void send({ message: text });
  };

  const decide = (id: string, ok: boolean) => {
    const next = items.map((i) => (i.kind === "approval" && i.id === id ? { ...i, decision: ok } : i));
    setItems(next);
    const open = next.filter((i) => i.kind === "approval" && i.decision === undefined);
    if (!open.length) {
      const approvals = Object.fromEntries(
        next.filter((i): i is Extract<Item, { kind: "approval" }> => i.kind === "approval" && pending.some((p) => p.id === i.id)).map((i) => [i.id, Boolean(i.decision)]),
      );
      void send({ approvals });
    }
  };

  const reset = () => {
    if (busy) return;
    setItems([]);
    setTranscript([]);
    setPaused(false);
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-49px)] w-full max-w-7xl flex-col px-10 pt-8">
      <UnsplashLayer photo={photo} className="shrink-0 rounded-3xl ring-1 ring-white/10">
        <div className="flex items-center gap-4 px-6 py-6">
          <span className="grid size-12 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
            <MessagesSquare className="size-6 text-white" />
          </span>
          <div className="flex-1">
            <h1 className="text-2xl font-extrabold tracking-tight text-white">Assistant</h1>
            <p className="text-sm text-ink/75">Tell it what you want done. It runs the commands, deploys, checks the result and keeps going until the job is done.</p>
          </div>
          {items.length > 0 && (
            <button onClick={reset} disabled={busy} className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-ink hover:bg-white/10 disabled:opacity-40">
              <RotateCcw className="size-3.5" /> New conversation
            </button>
          )}
        </div>
      </UnsplashLayer>

      <div className="scroll-thin mx-auto min-h-0 w-full max-w-4xl flex-1 space-y-3 overflow-y-auto py-5">
        {!configured && <Card className="p-5 text-sm text-ink">Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to enable the assistant.</Card>}

        {items.length === 0 && configured && (
          <div className="pt-6">
            <p className="text-center text-lg font-semibold text-white">What should I do?</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setItems([{ kind: "user", text: s }]);
                    void send({ message: s });
                  }}
                  className="rounded-xl border border-white/[0.08] bg-panel px-4 py-3 text-left text-sm text-zinc-200 hover:border-accent/60 hover:bg-panel-2"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((it, i) => {
          if (it.kind === "user")
            return (
              <div key={i} className="flex justify-end pt-2">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white px-4 py-2.5 text-sm text-[#0b0e1c]">{it.text}</div>
              </div>
            );
          if (it.kind === "text")
            return (
              <Card key={i} className="p-5 text-sm leading-relaxed">
                <Markdown text={it.text} />
              </Card>
            );
          if (it.kind === "step") return <Step key={it.id + i} step={it} />;
          return (
            <Card key={it.id} className={cx("p-4", it.decision === undefined ? "border-[var(--warning)]/50" : "opacity-70")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold text-white">
                    <ShieldAlert className="size-4 shrink-0 text-[var(--warning)]" />
                    Needs your OK: <span className="font-normal">{inline(it.label)}</span>
                  </p>
                  {it.detail && <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] text-ink">{it.detail}</pre>}
                </div>
                {it.decision === undefined ? (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="ghost" onClick={() => decide(it.id, false)} disabled={busy}>
                      <X className="size-3.5" /> Decline
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => decide(it.id, true)} disabled={busy}>
                      <Check className="size-3.5" /> Approve
                    </Button>
                  </div>
                ) : (
                  <span className="shrink-0 text-xs text-muted">{it.decision ? "approved" : "declined"}</span>
                )}
              </div>
            </Card>
          );
        })}

        {busy && (
          <div className="flex items-center gap-2 py-1 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Working…
          </div>
        )}
        {paused && !busy && (
          <div className="flex items-center gap-3 py-1 text-sm text-muted">
            Still going: it paused to stay within the time limit.
            <Button size="sm" variant="primary" onClick={() => void send({ message: "Continue." })}>
              <Play className="size-3.5" /> Continue
            </Button>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mx-auto mb-6 flex w-full max-w-4xl items-end gap-2 rounded-2xl border border-white/[0.08] bg-panel p-2"
      >
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
          placeholder={pending.length ? "Approve or decline above, or type to change course…" : "Tell it what to do… (Enter to send)"}
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-sm text-white placeholder:text-muted focus:outline-none"
        />
        {busy ? (
          <Button type="button" variant="danger" onClick={() => abort.current?.abort()}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!input.trim() || !configured}>
            <SendHorizonal className="size-4" />
          </Button>
        )}
      </form>
    </div>
  );
}

function Step({ step }: { step: Extract<Item, { kind: "step" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/20">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px]" disabled={!step.output}>
        {step.running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
        ) : step.ok ? (
          <Check className="size-3.5 shrink-0 text-accent" />
        ) : (
          <X className="size-3.5 shrink-0 text-[var(--critical-text)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-ink/90">{inline(step.label)}</span>
        {step.output && <ChevronRight className={cx("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")} />}
      </button>
      {open && step.output && (
        <pre className="scroll-thin max-h-72 overflow-auto border-t border-white/[0.06] px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-zinc-300">
          {step.output}
        </pre>
      )}
    </div>
  );
}
