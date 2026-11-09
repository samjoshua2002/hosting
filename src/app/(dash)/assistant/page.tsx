"use client";

import { ArrowUpRight, Brain, FileText, Layers, Link2, Loader2, MessageSquarePlus, Paperclip, Pencil, Pin, PinOff, Search, Server, ShieldCheck, Sparkles, Trash2, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { addFiles, currentDoc, editSession, hydrate, loadList, newSession, openSession, removeSession, send, setModel, setReview, setTitle, stop, updateItems, useAssistant, type Meta } from "@/components/assistant-store";
import { ArtifactView } from "@/components/artifact-view";
import { ChatItems } from "@/components/chat-items";
import { CopyButton } from "@/components/chat-blocks";
import { useCluster } from "@/components/cluster";
import { Composer, contextFor, entitiesFrom, type ModelChoice } from "@/components/composer";
import { Button, cx } from "@/components/ui";
import { latestArtifacts, type Att, type Item } from "@/lib/assistant-items";
import { api } from "@/lib/client";
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

export default function AssistantPage() {
  const { vms, status, refresh, reloadVms } = useCluster();
  const st = useAssistant();
  const doc = currentDoc(st);
  const sid = st.current;
  const { items, files, title } = doc;
  const busy = doc.busy || doc.remote;
  const [query, setQuery] = useState("");
  const [staged, setStaged] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [autopilot, setAutopilot] = useState<{ enabled: boolean; lastRun?: number; lastSummary?: string; sessionId?: string; canEnable?: boolean } | null>(null);
  const loadAutopilot = useCallback(
    () =>
      api<{ enabled: boolean; lastRun?: number; lastSummary?: string; sessionId?: string; canEnable?: boolean }>("/api/autopilot")
        .then(setAutopilot)
        .catch(() => setAutopilot(null)),
    [],
  );
  const [note, setNote] = useState<string | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const [memory, setMemory] = useState<{ id: string; text: string }[] | null>(null);
  const loadMemory = () =>
    api<{ memory: { id: string; text: string }[] }>("/api/memory")
      .then((r) => setMemory(r.memory))
      .catch(() => setMemory([]));
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
    void loadMemory();
    void loadAutopilot();
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
  }, [loadAutopilot]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, busy]);

  // when a run finishes, refresh machine status (it probably changed something)
  const [wasBusy, setWasBusy] = useState(false);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) {
      void refresh();
      void loadMemory();
    }
  }

  const entities = useMemo(() => entitiesFrom(vms, status), [vms, status]);
  const mentionNames = useMemo(() => new Set(entities.map((e) => e.name)), [entities]);

  const submit = async (raw: string) => {
    if ((!raw && !staged.length) || busy) return;
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
    if (!items.length) setTitle(sid, (text || staged[0]?.name || "New session").slice(0, 70));
    const withFiles = staged.length ? `${text}\n\n${staged.map((f) => `[Attached: ${f.name} (id ${f.id}, ${fmtSize(f.size)})]`).join("\n")}` : text;
    updateItems(sid, (x) => [
      ...x.map((i) => (i.kind === "approval" && i.decision === undefined ? { ...i, decision: false } : i.kind === "question" && i.answer === undefined ? { ...i, answer: text } : i)),
      // secrets never show, even for the moment before the server answers
      { kind: "user", text: hideSecrets(text), files: staged.length ? staged : undefined },
    ]);
    setStaged([]);
    void send(sid, { message: withFiles + contextFor(text, vms, status), display: text, staged });
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
  const artifacts = latestArtifacts(items);
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
                    <button key={s} onClick={() => void submit(s)} className="rounded-xl border border-white/[0.08] bg-panel px-4 py-3 text-left text-sm text-zinc-200 hover:border-accent/60">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <ChatItems sid={sid} items={items} busy={busy} mentions={mentionNames} onOpenArtifact={setArt} />

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

        <div className="mx-auto w-full max-w-3xl px-8 pb-6">
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

      {art && artVersions.length > 0 ? (
        <aside className="w-[min(760px,48%)] shrink-0 border-l border-white/[0.06] bg-panel/60">
          <ArtifactView key={`${art}-${artVersions.length}`} versions={artVersions} onClose={() => setArt(null)} />
        </aside>
      ) : (
      <aside className="scroll-thin w-80 shrink-0 space-y-6 overflow-y-auto border-l border-white/[0.06] p-5">
        <div className="rounded-2xl border border-[var(--line)] bg-panel px-4 py-4">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Session</p>
          <p className="mt-1 line-clamp-2 text-base font-semibold text-white">{title}</p>
          <p className="mt-1 text-xs text-muted">
            {stepCount} step{stepCount === 1 ? "" : "s"} · {st.review === "manual" ? "review each step" : "auto"} · saved on box5
          </p>
        </div>

        {artifacts.length > 0 && (
          <Section title="Artifacts" icon={<Layers className="size-3.5" />}>
            {artifacts.map((x) => (
              <button key={x.id} onClick={() => setArt(x.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/5">
                <FileText className="size-3.5 shrink-0 text-muted" />
                <span className="flex-1 truncate">{x.title}</span>
                {x.version > 1 && <span className="text-muted">v{x.version}</span>}
              </button>
            ))}
          </Section>
        )}

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
            <button key={s} onClick={() => void submit(s)} disabled={busy} className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/5 disabled:opacity-40">
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

        <Section title="Autopilot" icon={<ShieldCheck className="size-3.5" />}>
          {autopilot === null ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : (
            <div className="space-y-2 px-2">
              <label className="flex items-center justify-between gap-2 text-xs text-ink">
                <span>Check and fix the fleet every 15 min</span>
                <button
                  role="switch"
                  aria-checked={autopilot.enabled}
                  disabled={!autopilot.canEnable}
                  onClick={async () => {
                    try {
                      const r = await api<typeof autopilot>("/api/autopilot", { enabled: !autopilot.enabled });
                      setAutopilot({ ...autopilot, ...r });
                    } catch (e) {
                      setNote((e as Error).message);
                    }
                  }}
                  className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40", autopilot.enabled ? "bg-accent" : "bg-white/15")}
                >
                  <span className={cx("absolute top-0.5 size-4 rounded-full bg-white transition-all", autopilot.enabled ? "left-[18px]" : "left-0.5")} />
                </button>
              </label>
              {!autopilot.canEnable && <p className="text-[11px] text-muted">Needs CRON_SECRET in the environment.</p>}
              {autopilot.lastRun ? (
                <p className="text-[11px] text-muted">
                  Last check {timeAgo(autopilot.lastRun)}: {(autopilot.lastSummary ?? "").split("\n")[0]}
                </p>
              ) : (
                <p className="text-[11px] text-muted">Restarts crashed services and tunnels, clears full disks, and asks the Assistant to fix the rest. Emails you what it did.</p>
              )}
              <div className="flex gap-3 text-[11px]">
                <button
                  onClick={async () => {
                    await api("/api/autopilot", { run: true }).catch(() => null);
                    setNote("Autopilot is checking the fleet…");
                    setTimeout(() => {
                      void loadAutopilot();
                      setNote(null);
                      void loadList();
                    }, 25_000);
                  }}
                  className="text-accent-soft hover:text-white"
                >
                  Check now
                </button>
                {autopilot.sessionId && (
                  <button onClick={() => void openSession(autopilot.sessionId!)} className="text-accent-soft hover:text-white">
                    Open its session
                  </button>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section title="Memory" icon={<Brain className="size-3.5" />}>
          {memory === null ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : memory.length === 0 ? (
            <p className="text-xs text-muted">Tell it a preference (&quot;deploy Java apps on box3&quot;) and it remembers it in every session.</p>
          ) : (
            memory.map((m) => (
              <div key={m.id} className="group flex items-start gap-1.5 rounded-md px-2 py-1 text-xs text-ink hover:bg-white/5">
                <span className="flex-1">{m.text}</span>
                <button
                  onClick={() => void api<{ memory: { id: string; text: string }[] }>("/api/memory", { remove: m.id }).then((r) => setMemory(r.memory))}
                  className="hidden text-muted hover:text-[var(--critical-text)] group-hover:block"
                  aria-label="Forget"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))
          )}
        </Section>
      </aside>
      )}
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
