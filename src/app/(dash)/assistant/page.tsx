"use client";

import { CheckCircle2, Loader2, MessagesSquare, Play, SendHorizonal, ShieldAlert, Wrench, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCluster } from "@/components/cluster";
import { Badge, Button, Card, Output, cx } from "@/components/ui";
import { api } from "@/lib/client";
import { UnsplashLayer, useTheme } from "@/components/theme";
import { isDestructive } from "@/lib/safety";
import type { ExecResult } from "@/lib/types";

interface Proposal {
  id: string;
  title: string;
  why: string;
  command: string;
  targets: string[];
  risk: "low" | "medium" | "high";
  background: boolean;
}
interface Step {
  tool: string;
  label: string;
  ok: boolean;
}
interface Turn {
  role: "user" | "assistant";
  content: string;
  steps?: Step[];
  proposals?: Proposal[];
  model?: string;
  error?: boolean;
}

const STARTERS = [
  "Give me a health report of the whole fleet",
  "Which machine has the most room for a new Next.js app?",
  "Audit the security of every VM",
  "Find what is using the most disk and how to free it",
];

export default function AgentPage() {
  const { exec, startJobs, openJob } = useCluster();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(true);
  const { photo } = useTheme();
  const [runs, setRuns] = useState<Record<string, { state: "running" | "done"; results: ExecResult[] }>>({});
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ configured: boolean }>("/api/ai/models")
      .then((d) => setConfigured(d.configured))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [turns, busy]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: "user", content }];
    setTurns(next);
    setInput("");
    setBusy(true);
    try {
      const res = await api<{ reply: string; steps: Step[]; proposals: Proposal[]; model: string }>("/api/ai/chat", {
        messages: next.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })),
      });
      setTurns((t) => [...t, { role: "assistant", content: res.reply, steps: res.steps, proposals: res.proposals, model: res.model }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", content: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (p: Proposal) => {
    if (isDestructive(p.command) && !confirm(`This command can destroy data:\n\n${p.command}\n\nRun it on ${p.targets.join(", ")}?`)) return;
    if (p.background) {
      const jobs = await startJobs(p.targets, p.command, p.title);
      const first = jobs.find((j) => j.id);
      if (first?.id) openJob({ vm: first.vm, id: first.id, title: p.title });
      setRuns((r) => ({ ...r, [p.id]: { state: "done", results: [] } }));
      return;
    }
    setRuns((r) => ({ ...r, [p.id]: { state: "running", results: [] } }));
    const results = await exec(p.targets, p.command);
    setRuns((r) => ({ ...r, [p.id]: { state: "done", results } }));
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-49px)] max-w-4xl flex-col px-8">
      <UnsplashLayer photo={photo} className="mt-6 shrink-0 rounded-3xl ring-1 ring-white/10">
        <div className="flex items-center gap-4 px-6 py-6">
          <span className="grid size-12 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
            <MessagesSquare className="size-6 text-white" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white">Assistant</h1>
            <p className="text-sm text-ink/75">Ask about your servers. It checks them read-only; anything that changes a machine waits for your OK.</p>
          </div>
        </div>
      </UnsplashLayer>

      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto py-5">
        {!configured && (
          <Card className="p-5 text-sm text-ink">Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY to enable the assistant.</Card>
        )}
        {turns.length === 0 && configured && (
          <div className="pt-6 text-center">
            <p className="text-lg font-semibold text-white">What should I look into?</p>
            <div className="mx-auto mt-5 grid max-w-2xl gap-2 sm:grid-cols-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-xl border border-white/[0.08] bg-[var(--panel)] px-4 py-3 text-left text-sm text-zinc-200 hover:border-[var(--accent)]/60 hover:bg-[var(--panel-2)]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white px-4 py-2.5 text-sm text-[#0b0e1c]">{t.content}</div>
            </div>
          ) : (
            <div key={i} className="space-y-3">
              {t.steps && t.steps.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.steps.map((s, j) => (
                    <span key={j} className={cx("flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]", s.ok ? "border-white/10 text-muted" : "border-rose-900/60 text-rose-300")}>
                      <Wrench className="size-3" /> {s.label}
                    </span>
                  ))}
                </div>
              )}
              <Card className={cx("p-5 text-sm leading-relaxed", t.error && "border-rose-900/60 text-rose-300")}>
                <Markdown text={t.content} />
              </Card>
              {t.proposals?.map((p) => {
                const run = runs[p.id];
                return (
                  <Card key={p.id} className="border-[var(--accent)]/30 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-semibold text-white">
                          {p.title}
                          <Badge tone={p.risk === "high" ? "red" : p.risk === "medium" ? "amber" : "green"}>{p.risk} risk</Badge>
                        </p>
                        <p className="mt-1 text-xs text-muted">{p.why}</p>
                      </div>
                      <Button size="sm" variant={run ? "default" : "primary"} onClick={() => approve(p)} loading={run?.state === "running"}>
                        {p.risk === "high" ? <ShieldAlert className="size-3.5" /> : <Play className="size-3.5" />}
                        {run ? "Run again" : `Approve & run on ${p.targets.join(", ")}`}
                      </Button>
                    </div>
                    <pre className="mt-3 overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] text-ink">{p.command}</pre>
                    {run?.results.map((r) => (
                      <div key={r.vm} className="mt-3">
                        <p className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                          {r.code === 0 ? <CheckCircle2 className="size-3.5 text-[var(--good-text)]" /> : <XCircle className="size-3.5 text-rose-400" />}
                          <span className="font-mono">{r.vm}</span> · {r.code === null ? r.error : `exit ${r.code}`}
                        </p>
                        <Output text={r.stdout} className="max-h-48" />
                        <Output text={r.stderr} tone="err" className="mt-1 max-h-32" />
                      </div>
                    ))}
                  </Card>
                );
              })}
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Checking your machines… (this can take a minute)
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="mb-4 flex items-end gap-2 rounded-2xl border border-white/[0.08] bg-[var(--panel)] p-2"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={1}
          placeholder="e.g. Why is box2 slow?  (Enter to send)"
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none"
        />
        <Button type="submit" variant="primary" disabled={!input.trim() || busy || !configured}>
          <SendHorizonal className="size-4" />
        </Button>
      </form>
    </div>
  );
}

/** Tiny, safe markdown: headings, bullets, numbered lists, **bold**, `code`, code blocks. No HTML injection. */
function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      blocks.push(
        <pre key={i} className="my-2 overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] text-ink">
          {code.join("\n")}
        </pre>,
      );
    } else if (/^#{1,4}\s/.test(line)) {
      blocks.push(
        <p key={i} className="mt-3 mb-1 font-semibold text-white">
          {inline(line.replace(/^#+\s/, ""))}
        </p>,
      );
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      blocks.push(
        <div key={i} className="flex gap-2 pl-1 text-zinc-200" style={{ paddingLeft: `${(line.match(/^\s*/)?.[0].length ?? 0) * 6 + 4}px` }}>
          <span className="text-[var(--accent-soft)]">{/^\s*\d+\./.test(line) ? line.trim().split(" ")[0] : "•"}</span>
          <span>{inline(line.replace(/^\s*([-*]|\d+\.)\s/, ""))}</span>
        </div>,
      );
    } else if (line.trim()) {
      blocks.push(
        <p key={i} className="my-1 text-zinc-200">
          {inline(line)}
        </p>,
      );
    } else blocks.push(<div key={i} className="h-2" />);
  }
  return <div>{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[12px] text-ink">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("**") && part.endsWith("**") ? (
      <b key={i} className="font-semibold text-white">
        {part.slice(2, -2)}
      </b>
    ) : (
      part
    ),
  );
}
