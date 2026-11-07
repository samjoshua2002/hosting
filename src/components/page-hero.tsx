"use client";

import type { ReactNode } from "react";
import { UnsplashLayer, useTheme } from "./theme";

/**
 * Shared page top, same look as the Overview: the session's Unsplash photo as a full-width cover that fades into
 * the page (anchored to the shell's <main>), a photo tile with the page icon, and a large title.
 */
export function PageHero({ eyebrow, title, desc, actions, icon }: { eyebrow?: string; title: string; desc?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  const { photo } = useTheme();
  return (
    <>
      <UnsplashLayer photo={photo} className="page-cover" />
      <header className="flex items-center gap-6 pt-4 pb-2">
        {icon && (
          <UnsplashLayer photo={photo} className="grid size-24 shrink-0 place-items-center rounded-3xl shadow-2xl ring-1 ring-white/10 [&_svg]:size-10 [&_svg]:text-white [&_svg]:drop-shadow-lg">
            {icon}
          </UnsplashLayer>
        )}
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="text-xs font-bold tracking-[0.14em] text-ink/90 uppercase">{eyebrow}</p>}
          <h1 className="mt-1 text-5xl font-extrabold tracking-[-0.03em] text-white">{title}</h1>
          {desc && <p className="mt-2 max-w-2xl text-[15px] text-ink/75">{desc}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2 self-end">{actions}</div>}
      </header>
    </>
  );
}
