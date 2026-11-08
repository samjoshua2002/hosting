"use client";

import type { ReactNode } from "react";

/** Page top: title, one line of context, actions on the right. (The breadcrumb lives in the top bar.) */
export function PageHero({ title, desc, actions }: { eyebrow?: string; title: string; desc?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <header className="flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {desc && <p className="mt-1 max-w-3xl text-sm text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
