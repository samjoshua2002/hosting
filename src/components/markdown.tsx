"use client";

import type { ReactNode } from "react";

/** Tiny, safe markdown: headings, bullets, numbered lists, **bold**, `code`, code blocks. No HTML injection. */
export function Markdown({ text }: { text: string }) {
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

export function inline(s: string): ReactNode[] {
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
