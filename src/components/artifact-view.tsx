"use client";

import { Braces, ChevronRight, Code2, Download, ExternalLink, FileText, Globe, ImageIcon, Monitor, Smartphone, Table2, Tablet, X, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { ArtifactType, Item } from "@/lib/assistant-items";
import { CopyButton } from "./chat-blocks";
import { Markdown } from "./markdown";
import { cx } from "./ui";

export type Artifact = Extract<Item, { kind: "artifact" }>;

const ICON: Record<ArtifactType, LucideIcon> = { markdown: FileText, html: Globe, code: Code2, csv: Table2, json: Braces, svg: ImageIcon, text: FileText };
const LABEL: Record<ArtifactType, string> = { markdown: "Document", html: "Web page", code: "Code", csv: "Table", json: "JSON", svg: "Image", text: "Text" };
const EXT: Record<string, string> = { bash: "sh", sh: "sh", shell: "sh", python: "py", py: "py", typescript: "ts", ts: "ts", tsx: "tsx", javascript: "js", js: "js", yaml: "yaml", yml: "yml", sql: "sql", go: "go", java: "java", rust: "rs", dockerfile: "Dockerfile", nginx: "conf", toml: "toml", ini: "ini" };

const size = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function fileName(a: Artifact): string {
  const base = a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact";
  const ext = a.type === "markdown" ? "md" : a.type === "code" ? (EXT[(a.language ?? "").toLowerCase()] ?? "txt") : a.type === "text" ? "txt" : a.type;
  return ext === "Dockerfile" ? "Dockerfile" : `${base}.${ext}`;
}

function download(a: Artifact) {
  const mime = { markdown: "text/markdown", html: "text/html", csv: "text/csv", json: "application/json", svg: "image/svg+xml", code: "text/plain", text: "text/plain" }[a.type];
  const url = URL.createObjectURL(new Blob([a.content], { type: `${mime};charset=utf-8` }));
  const el = document.createElement("a");
  el.href = url;
  el.download = fileName(a);
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The card shown in the conversation. */
export function ArtifactCard({ a, onOpen }: { a: Artifact; onOpen: () => void }) {
  const Icon = ICON[a.type];
  return (
    <button onClick={onOpen} className="group flex w-full max-w-md items-center gap-3 rounded-2xl border border-line-strong bg-panel p-3 text-left transition-colors hover:border-accent/60">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-line-strong bg-chip text-ink">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-white">{a.title}</span>
        <span className="block text-xs text-muted">
          {a.type === "code" && a.language ? a.language : LABEL[a.type]} · {size(a.content.length)}
          {a.version > 1 ? ` · version ${a.version}` : ""}
        </span>
      </span>
      <span className="flex items-center gap-1 text-xs text-muted group-hover:text-white">
        Open <ChevronRight className="size-3.5" />
      </span>
    </button>
  );
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** Side panel: preview / source, versions, copy, download. */
export function ArtifactView({ versions, onClose, initialTab }: { versions: Artifact[]; onClose: () => void; initialTab?: "preview" | "source" }) {
  const [v, setV] = useState(versions.length - 1);
  const a = versions[Math.min(v, versions.length - 1)];
  const previewable = a.type !== "code" && a.type !== "text";
  const [tab, setTab] = useState<"preview" | "source">(previewable && initialTab !== "source" ? "preview" : "source");
  const Icon = ICON[a.type];
  const rows = useMemo(() => (a.type === "csv" ? csvRows(a.content).slice(0, 2000) : []), [a]);
  // designs: see them at the sizes people will
  const [device, setDevice] = useState<"desktop" | "tablet" | "phone">("desktop");
  const width = device === "phone" ? 390 : device === "tablet" ? 820 : null;
  const openTab = () => {
    const url = URL.createObjectURL(new Blob([a.content], { type: a.type === "svg" ? "image/svg+xml" : "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <Icon className="size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{a.title}</p>
          <p className="text-[11px] text-muted">
            {a.type === "code" && a.language ? a.language : LABEL[a.type]} · {size(a.content.length)}
          </p>
        </div>
        {versions.length > 1 && (
          <select value={v} onChange={(e) => setV(Number(e.target.value))} className="h-7 rounded-md border border-line-strong bg-transparent px-1.5 text-xs text-ink">
            {versions.map((x, i) => (
              <option key={i} value={i}>
                Version {x.version}
              </option>
            ))}
          </select>
        )}
        {previewable && (
          <div className="flex rounded-lg border border-white/[0.08] p-0.5 text-xs">
            {(["preview", "source"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cx("rounded-md px-2 py-0.5 capitalize", tab === t ? "bg-white/[0.1] text-white" : "text-muted hover:text-white")}>
                {t}
              </button>
            ))}
          </div>
        )}
        {a.type === "html" && tab === "preview" && (
          <div className="flex rounded-lg border border-white/[0.08] p-0.5" role="group" aria-label="Preview size">
            {([
              ["desktop", Monitor],
              ["tablet", Tablet],
              ["phone", Smartphone],
            ] as const).map(([d, I]) => (
              <button key={d} onClick={() => setDevice(d)} title={d[0].toUpperCase() + d.slice(1)} className={cx("rounded-md p-1", device === d ? "bg-white/[0.1] text-white" : "text-muted hover:text-white")}>
                <I className="size-3.5" />
              </button>
            ))}
          </div>
        )}
        {(a.type === "html" || a.type === "svg") && (
          <button onClick={openTab} className="rounded-md p-1 text-muted hover:bg-white/[0.08] hover:text-white" title="Open in a new tab">
            <ExternalLink className="size-3.5" />
          </button>
        )}
        <CopyButton text={a.content} label="Copy" />
        <button onClick={() => download(a)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/[0.08] hover:text-white" title={`Download ${fileName(a)}`}>
          <Download className="size-3.5" /> Download
        </button>
        <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-white/5 hover:text-white" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {tab === "source" || !previewable ? (
          <pre className="px-4 py-3 font-mono text-[12px] leading-relaxed text-ink">
            {a.content.split("\n").map((l, i) => (
              <div key={i} className="flex">
                <span className="w-10 shrink-0 pr-3 text-right text-muted/60 select-none">{i + 1}</span>
                <span className="whitespace-pre-wrap break-all">{l || " "}</span>
              </div>
            ))}
          </pre>
        ) : a.type === "markdown" ? (
          <div className="px-6 py-5 text-[14.5px] leading-relaxed">
            <Markdown text={a.content} />
          </div>
        ) : a.type === "html" || a.type === "svg" ? (
          // sandboxed: scripts run, but it can't touch the dashboard or its cookies
          <div className={cx("h-full min-h-[480px]", width && "bg-[var(--sidebar)] px-4 py-5")}>
            <iframe
              title={a.title}
              sandbox="allow-scripts allow-popups"
              srcDoc={a.type === "svg" ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${a.content}</body>` : a.content}
              className={cx("h-full min-h-[480px] bg-white", width ? "mx-auto rounded-xl shadow-2xl shadow-black/60 ring-1 ring-white/10" : "w-full")}
              style={width ? { width, maxWidth: "100%" } : undefined}
            />
          </div>
        ) : a.type === "csv" ? (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr>
                {(rows[0] ?? []).map((h, i) => (
                  <th key={i} className="border-b border-white/[0.08] px-3 py-2 font-semibold text-white">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, i) => (
                <tr key={i} className="border-b border-white/[0.04]">
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-1.5 text-ink">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">{prettyJson(a.content)}</pre>
        )}
      </div>
    </div>
  );
}

function prettyJson(t: string): string {
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}
