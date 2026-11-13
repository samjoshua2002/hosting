"use client";

// Preview of a file in the conversation (attached by the user or made by the Assistant): pictures and PDFs inline,
// code and text with line numbers, Markdown rendered, CSV as a table, zips as a file tree. Download stays one click away.
import { Archive, ArrowLeft, Download, File, FileCode2, FileImage, FileJson, FileSpreadsheet, FileText, Folder, Loader2, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { CopyButton } from "./chat-blocks";
import { Markdown } from "./markdown";
import { cx } from "./ui";

type Kind = "image" | "pdf" | "text" | "markdown" | "csv" | "json" | "html" | "zip" | "binary";
interface Preview {
  name: string;
  size: number;
  kind: Kind;
  text?: string;
  truncated?: boolean;
  language?: string;
  entries?: { path: string; size: number }[];
  totalFiles?: number;
}

const ICON: Record<Kind, LucideIcon> = { image: FileImage, pdf: FileText, text: FileCode2, markdown: FileText, csv: FileSpreadsheet, json: FileJson, html: FileCode2, zip: Archive, binary: File };
const LABEL: Record<Kind, string> = { image: "Image", pdf: "PDF", text: "Text", markdown: "Markdown", csv: "Table", json: "JSON", html: "HTML", zip: "Zip archive", binary: "File" };

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function csvRows(t: string): string[][] {
  const sep = t.split("\n", 1)[0].includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell.replace(/\r$/, "")), rows.push(row), (row = []), (cell = "");
    else cell += c;
    if (rows.length > 2000) break;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

/** A zip's paths as an indented tree (folders first). */
function tree(entries: { path: string; size: number }[]): { depth: number; name: string; dir: boolean; size?: number; path: string }[] {
  const out: { depth: number; name: string; dir: boolean; size?: number; path: string }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const parts = e.path.split("/");
    parts.forEach((p, i) => {
      const key = parts.slice(0, i + 1).join("/");
      if (seen.has(key)) return;
      seen.add(key);
      const dir = i < parts.length - 1;
      out.push({ depth: i, name: p, dir, size: dir ? undefined : e.size, path: key });
    });
  }
  return out;
}

export function AttachmentView({ session, id, name, onClose, entry, onBack }: { session: string; id: string; name: string; onClose: () => void; entry?: string; onBack?: () => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "source">("preview");
  // a file opened from inside this zip: shown with the same viewer, a back arrow returns to the file list
  const [inside, setInside] = useState<string | null>(null);
  const base = `/api/attachments?session=${encodeURIComponent(session)}&id=${encodeURIComponent(id)}${entry ? `&entry=${encodeURIComponent(entry)}` : ""}`;

  useEffect(() => {
    let alive = true;
    api<Preview>(`${base}&view=1`).then(
      (x) => alive && setP(x),
      (e: Error) => alive && setErr(e.message),
    );
    return () => {
      alive = false;
    };
  }, [base]);

  const rows = useMemo(() => (p?.kind === "csv" && p.text ? csvRows(p.text) : []), [p]);
  const nodes = useMemo(() => (p?.kind === "zip" && p.entries ? tree(p.entries) : []), [p]);
  const kind = p?.kind ?? "binary";
  const Icon = ICON[kind];
  const hasSource = p && ["markdown", "csv", "json", "html"].includes(p.kind);

  if (inside) return <AttachmentView key={inside} session={session} id={id} name={inside.split("/").pop() || inside} entry={inside} onBack={() => setInside(null)} onClose={onClose} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        {onBack && (
          <button onClick={onBack} className="rounded-md p-1 text-muted hover:bg-white/5 hover:text-white" aria-label="Back to the zip" title="Back to the zip">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <Icon className="size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{p?.name ?? name}</p>
          <p className="text-[11px] text-muted">
            {p ? `${p.language && p.kind === "text" ? p.language : LABEL[p.kind]} · ${fmtSize(p.size)}${p.kind === "zip" ? ` · ${p.totalFiles} files` : ""}${p.truncated ? " · first 300 KB" : ""}` : "Loading…"}
          </p>
        </div>
        {hasSource && (
          <div className="flex rounded-lg border border-white/[0.08] p-0.5 text-xs">
            {(["preview", "source"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cx("rounded-md px-2 py-0.5 capitalize", tab === t ? "bg-white/[0.1] text-white" : "text-muted hover:text-white")}>
                {t}
              </button>
            ))}
          </div>
        )}
        {p?.text !== undefined && p.kind !== "text" ? <CopyButton text={p.text} label="Copy" /> : p?.kind === "text" && p.language !== "dotenv" && p.text ? <CopyButton text={p.text} label="Copy" /> : null}
        <a href={base} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/[0.08] hover:text-white" title={`Download ${name}`}>
          <Download className="size-3.5" /> Download
        </a>
        <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-white/5 hover:text-white" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {err ? (
          <p className="p-5 text-sm text-[var(--critical-text)]">{err}</p>
        ) : !p ? (
          <p className="flex items-center gap-2 p-5 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Opening {name}…
          </p>
        ) : p.kind === "image" ? (
          <div className="grid min-h-full place-items-center bg-[repeating-conic-gradient(#18181b_0%_25%,#111113_0%_50%)] bg-[length:20px_20px] p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${base}&inline=1`} alt={p.name} className="max-h-[78vh] max-w-full rounded-md shadow-2xl shadow-black/60" />
          </div>
        ) : p.kind === "pdf" ? (
          <iframe title={p.name} src={`${base}&inline=1`} className="h-full min-h-[600px] w-full bg-white" />
        ) : p.kind === "zip" ? (
          <ul className="px-3 py-2 font-mono text-[12px]">
            {nodes.map((n, i) => (
              <li key={i}>
                <button
                  disabled={n.dir}
                  onClick={() => !n.dir && setInside(n.path)}
                  className={cx("flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left", n.dir ? "cursor-default" : "hover:bg-white/[0.05]")}
                  style={{ paddingLeft: `${n.depth * 14 + 4}px` }}
                  title={n.dir ? undefined : `Open ${n.path}`}
                >
                  {n.dir ? <Folder className="size-3.5 shrink-0 text-[var(--accent)]" /> : <File className="size-3.5 shrink-0 text-zinc-500" />}
                  <span className={cx("truncate", n.dir ? "text-zinc-200" : "text-zinc-300 hover:text-white")}>{n.name}</span>
                  {!n.dir && <span className="ml-auto shrink-0 pl-3 text-[10.5px] text-zinc-600">{fmtSize(n.size ?? 0)}</span>}
                </button>
              </li>
            ))}
            {(p.totalFiles ?? 0) > (p.entries?.length ?? 0) && <li className="px-1 py-1 text-zinc-500">… and {(p.totalFiles ?? 0) - (p.entries?.length ?? 0)} more</li>}
          </ul>
        ) : p.kind === "binary" ? (
          <div className="grid min-h-[50vh] place-items-center p-6 text-center">
            <div>
              <File className="mx-auto size-10 text-zinc-600" />
              <p className="mt-3 text-sm text-zinc-300">{p.name}</p>
              <p className="mt-1 text-xs text-muted">{fmtSize(p.size)} · no preview for this kind of file</p>
              <a href={base} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-white/90">
                <Download className="size-3.5" /> Download
              </a>
            </div>
          </div>
        ) : tab === "preview" && p.kind === "markdown" ? (
          <div className="px-6 py-5 text-[14.5px] leading-relaxed">
            <Markdown text={p.text ?? ""} />
          </div>
        ) : tab === "preview" && p.kind === "csv" ? (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr>
                {(rows[0] ?? []).map((h, i) => (
                  <th key={i} className="border-b border-white/[0.08] px-3 py-2 font-semibold whitespace-nowrap text-white">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, i) => (
                <tr key={i} className="border-b border-white/[0.04]">
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-1.5 whitespace-nowrap text-ink">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "preview" && p.kind === "html" ? (
          // the page runs sandboxed: no access to the dashboard, its cookies or other tabs
          <iframe title={p.name} sandbox="allow-scripts" srcDoc={p.text} className="h-full min-h-[600px] w-full bg-white" />
        ) : (
          <pre className="px-4 py-3 font-mono text-[12px] leading-relaxed text-ink">
            {(p.kind === "json" && tab === "preview" ? pretty(p.text ?? "") : (p.text ?? "")).split("\n").map((l, i) => (
              <div key={i} className="flex">
                <span className="w-10 shrink-0 pr-3 text-right text-muted/60 select-none">{i + 1}</span>
                <span className="break-all whitespace-pre-wrap">{l || " "}</span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

function pretty(t: string): string {
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}
