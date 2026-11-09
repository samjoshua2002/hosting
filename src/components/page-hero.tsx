"use client";

import type { ReactNode } from "react";

/** Page top: title, one line of context, actions on the right. (The breadcrumb lives in the top bar.) */
export function PageHero({ title, desc, actions }: { eyebrow?: string; title: string; desc?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <header className="flex min-h-[150px] items-end justify-between gap-6 pt-16 [text-shadow:0_1px_12px_rgb(0_0_0/0.6)]">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight text-white">{title}</h1>
        {desc && <p className="mt-1.5 max-w-3xl text-sm text-zinc-300">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
