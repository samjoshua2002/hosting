"use client";

import type { ReactNode } from "react";
import { CopyButton, LinkChip } from "./chat-blocks";

/** Tiny, safe markdown: headings, lists, **bold**, `code`, links (open + copy), code blocks (copy; bash looks like a terminal). No HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim().toLowerCase();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      const src = code.join("\n");
      const shell = /^(bash|sh|shell|zsh|console|terminal)$/.test(lang);
      blocks.push(
        <div key={i} className={`group relative my-2 overflow-hidden rounded-xl border ${shell ? "border-white/[0.08] bg-term" : "border-white/[0.06] bg-black/40"}`}>
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1">
            <span className="font-mono text-[10.5px] text-muted">{lang || "text"}</span>
            <CopyButton text={src} label="Copy" />
          </div>
          <pre className="scroll-thin overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
            {shell
              ? code.map((l, k) => (
                  <div key={k}>
                    {l.trim() && !l.startsWith("#") && <span className="text-accent-soft select-none">$ </span>}
                    {l}
                  </div>
                ))
              : src}
          </pre>
        </div>,
      );
    } else if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      // a table: header | separator | rows
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push(
        <div key={i} className="scroll-thin my-3 overflow-x-auto rounded-xl border border-white/[0.08]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white/[0.04]">
              <tr>
                {head.map((h, k) => (
                  <th key={k} className="px-3 py-2 font-semibold text-white">
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {rows.map((r, k) => (
                <tr key={k}>
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-1.5 text-zinc-200">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      blocks.push(
        <p key={i} className={level === 1 ? "mt-4 mb-2 text-xl font-bold text-white" : level === 2 ? "mt-4 mb-1.5 text-base font-semibold text-white" : "mt-3 mb-1 font-semibold text-white"}>
          {inline(line.replace(/^#+\s/, ""))}
        </p>,
      );
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      blocks.push(
        <div key={i} className="flex gap-2 pl-1 text-zinc-200" style={{ paddingLeft: `${(line.match(/^\s*/)?.[0].length ?? 0) * 6 + 4}px` }}>
          <span className="text-[var(--accent-soft)]">{/^\s*\d+\./.test(line) ? line.trim().split(" ")[0] : "•"}</span>
          <span className="min-w-0">{inline(line.replace(/^\s*([-*]|\d+\.)\s/, ""))}</span>
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

const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)<>"'`\]]+|(?<![\w.@])@[a-z0-9][a-z0-9-]*)/g;

export function inline(s: string, mentions?: Set<string>): ReactNode[] {
  return s.split(TOKEN).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1)
      return (
        <code key={i} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[12px] text-ink">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <b key={i} className="font-semibold text-white">
          {/* links, code and URLs inside bold work too ("**[Download](https://…)**") */}
          {inline(part.slice(2, -2), mentions)}
        </b>
      );
    const md = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (md) return <LinkChip key={i} href={md[2]}>{md[1]}</LinkChip>;
    if (/^https?:\/\//.test(part)) {
      const url = part.replace(/[.,;:!?]+$/, "");
      return (
        <span key={i}>
          <LinkChip href={url} />
          {part.slice(url.length)}
        </span>
      );
    }
    if (part.startsWith("@") && (!mentions || mentions.has(part.slice(1))))
      return (
        <span key={i} className="rounded bg-accent/20 px-1 font-medium text-white">
          {part}
        </span>
      );
    return part;
  });
}
