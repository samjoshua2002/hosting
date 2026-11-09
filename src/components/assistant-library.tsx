"use client";

// The Assistant's library, like Claude's: a search across conversations and artifacts, and a gallery of
// everything the Assistant has made.
import { Code2, FileText, Globe, ImageIcon, Layers, Loader2, MessageSquare, Search, Table2, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import { cx } from "./ui";

export interface ArtifactEntry {
  session: string;
  sessionTitle: string;
  id: string;
  title: string;
  type: string;
  language?: string;
  version: number;
  updatedAt: number;
  preview: string;
}

const TYPE_ICON: Record<string, LucideIcon> = { html: Globe, svg: ImageIcon, markdown: FileText, code: Code2, csv: Table2, json: Code2, text: FileText };
const TYPE_LABEL: Record<string, string> = { html: "Design", svg: "Graphic", markdown: "Document", code: "Code", csv: "Table", json: "Data", text: "Text" };

let artifactsCache: Promise<ArtifactEntry[]> | null = null;
export function loadArtifacts(fresh = false): Promise<ArtifactEntry[]> {
  if (!artifactsCache || fresh)
    artifactsCache = api<{ artifacts: ArtifactEntry[] }>(`/api/artifacts${fresh ? "?fresh=1" : ""}`)
      .then((r) => r.artifacts)
      .catch((e) => {
        artifactsCache = null;
        throw e;
      });
  return artifactsCache;
}

/** A small live preview of an artifact (designs render scaled down, sandboxed). */
function Thumb({ a }: { a: ArtifactEntry }) {
  if (a.type === "html" || a.type === "svg")
    return (
      <div className="relative h-full w-full overflow-hidden bg-white">
        <iframe
          title={a.title}
          sandbox=""
          tabIndex={-1}
          srcDoc={a.type === "svg" ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${a.preview}</body>` : a.preview}
          className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25 border-0"
        />
      </div>
    );
  const Icon = TYPE_ICON[a.type] ?? FileText;
  return (
    <div className="relative h-full w-full overflow-hidden bg-panel-2 p-3">
      <pre className="font-mono text-[9px] leading-[1.45] whitespace-pre-wrap text-zinc-500">{a.preview.slice(0, 700)}</pre>
      <span className="absolute right-2 bottom-2 grid size-7 place-items-center rounded-md bg-black/60 text-zinc-300">
        <Icon className="size-3.5" />
      </span>
    </div>
  );
}

export function ArtifactsGallery({ onOpen }: { onOpen: (a: ArtifactEntry) => void }) {
  const [list, setList] = useState<ArtifactEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("all");
  useEffect(() => {
    loadArtifacts(true).then(setList, (e: Error) => setErr(e.message));
  }, []);
  const kinds = useMemo(() => ["all", ...new Set((list ?? []).map((a) => a.type))], [list]);
  const shown = (list ?? []).filter((a) => (kind === "all" || a.type === kind) && (!q || `${a.title} ${a.sessionTitle}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="flex items-end gap-4">
        <h1 className="flex-1 text-[28px] font-semibold tracking-tight text-white">Artifacts</h1>
        <label className="flex w-64 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5">
          <Search className="size-3.5 text-zinc-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search artifacts" className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-zinc-600" />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-1">
        {kinds.map((k) => (
          <button key={k} onClick={() => setKind(k)} className={cx("rounded-md px-2.5 py-1 text-[13px] transition-colors", kind === k ? "bg-white/[0.09] text-white" : "text-zinc-400 hover:text-white")}>
            {k === "all" ? "All" : (TYPE_LABEL[k] ?? k)}
          </button>
        ))}
      </div>
      {err ? (
        <p className="mt-10 text-sm text-[var(--critical-text)]">{err}</p>
      ) : !list ? (
        <p className="mt-10 flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" /> Gathering artifacts from your conversations…
        </p>
      ) : shown.length === 0 ? (
        <div className="mt-16 text-center">
          <Layers className="mx-auto size-8 text-zinc-700" />
          <p className="mt-3 text-sm text-zinc-400">{list.length ? "Nothing matches." : "No artifacts yet."}</p>
          <p className="mt-1 text-xs text-zinc-600">Ask for a design, a report, a script or a page, and it shows up here.</p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
          {shown.map((a) => {
            const Icon = TYPE_ICON[a.type] ?? FileText;
            return (
              <button key={`${a.session}-${a.id}`} onClick={() => onOpen(a)} className="group overflow-hidden rounded-xl border border-white/[0.07] bg-panel text-left transition-colors hover:border-white/[0.18]">
                <div className="aspect-[16/10] border-b border-white/[0.06]">
                  <Thumb a={a} />
                </div>
                <div className="flex items-center gap-3 px-3.5 py-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-zinc-400">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-zinc-100 group-hover:text-white">{a.title}</span>
                    <span className="block truncate text-[11.5px] text-zinc-500">
                      {TYPE_LABEL[a.type] ?? a.type}
                      {a.version > 1 ? ` · v${a.version}` : ""} · {timeAgo(a.updatedAt)}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SessionLite = { id: string; title: string; updatedAt: number; pinned?: boolean };

export function SearchDialog({ sessions, onClose, onSession, onArtifact }: { sessions: SessionLite[]; onClose: () => void; onSession: (id: string) => void; onArtifact: (a: ArtifactEntry) => void }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "sessions" | "artifacts">("all");
  const [arts, setArts] = useState<ArtifactEntry[] | null>(null);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    loadArtifacts().then(setArts, () => setArts([]));
  }, []);
  const match = (t: string) => !q || t.toLowerCase().includes(q.toLowerCase());
  const rows = [
    ...(tab !== "artifacts" ? sessions.filter((s) => match(s.title)).slice(0, q ? 30 : 8).map((s) => ({ kind: "session" as const, s })) : []),
    ...(tab !== "sessions" ? (arts ?? []).filter((a) => match(`${a.title} ${a.sessionTitle}`)).slice(0, q ? 30 : 6).map((a) => ({ kind: "artifact" as const, a })) : []),
  ];
  const index = Math.min(hi, Math.max(0, rows.length - 1));
  const pick = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === "session") onSession(r.s.id);
    else onArtifact(r.a);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className="w-[640px] max-w-[92vw] overflow-hidden rounded-2xl border border-white/[0.09] bg-pop shadow-2xl shadow-black/70" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 pt-4">
          <Search className="size-4 text-zinc-500" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") return onClose();
              const n = Math.max(1, rows.length);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((index + 1) % n);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((index - 1 + n) % n);
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(index);
              } else if (e.key === "Tab") {
                e.preventDefault();
                setTab((t) => (t === "all" ? "sessions" : t === "sessions" ? "artifacts" : "all"));
              }
            }}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-white placeholder:text-zinc-500"
          />
          <button onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:text-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex gap-1 border-b border-white/[0.06] px-4 pt-3 pb-2.5">
          {(["all", "sessions", "artifacts"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx("rounded-md px-2.5 py-1 text-[13px] capitalize", tab === t ? "bg-white/[0.09] text-white" : "text-zinc-400 hover:text-white")}>
              {t}
            </button>
          ))}
        </div>
        <div className="scroll-thin max-h-[52vh] overflow-y-auto p-2">
          {!q && <p className="px-3 pt-1 pb-1.5 text-[11.5px] text-zinc-500">Recents</p>}
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">{arts === null && tab !== "sessions" ? "Loading…" : "Nothing found."}</p>
          ) : (
            rows.map((r, i) => {
              const Icon = r.kind === "session" ? MessageSquare : (TYPE_ICON[r.a.type] ?? FileText);
              return (
                <button
                  key={r.kind === "session" ? `s-${r.s.id}` : `a-${r.a.session}-${r.a.id}`}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(i)}
                  className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === index && "bg-white/[0.07]")}
                >
                  <Icon className="size-4 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-zinc-100">{r.kind === "session" ? r.s.title : r.a.title}</span>
                  <span className="shrink-0 text-[11.5px] text-zinc-500">{r.kind === "session" ? timeAgo(r.s.updatedAt) : `${TYPE_LABEL[r.a.type] ?? r.a.type} · ${r.a.sessionTitle}`.slice(0, 48)}</span>
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-white/[0.06] px-5 py-2.5 text-[11.5px] text-zinc-500">
          <span>
            Close <kbd className="rounded border border-white/10 px-1">Esc</kbd>
          </span>
          <span>
            Change type <kbd className="rounded border border-white/10 px-1">Tab</kbd>
          </span>
          <span className="flex-1" />
          <span>
            Open <kbd className="rounded border border-white/10 px-1">↵</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
