"use client";

import type { ReactNode } from "react";
import { UnsplashLayer, useTheme } from "./theme";

/** Shared page top: the session's Unsplash photo as a wide banner behind a title. */
export function PageHero({ eyebrow, title, desc, actions, icon }: { eyebrow?: string; title: string; desc?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  const { photo } = useTheme();
  return (
    <UnsplashLayer photo={photo} className="rounded-3xl ring-1 ring-white/10">
      <div className="flex min-h-[168px] items-end justify-between gap-6 px-8 pt-10 pb-7">
        <div className="flex items-end gap-5">
          {icon && <span className="grid size-14 place-items-center rounded-2xl bg-white/10 text-white ring-1 ring-white/20 backdrop-blur">{icon}</span>}
          <div>
            {eyebrow && <p className="text-[11px] font-bold tracking-[0.14em] text-ink/90 uppercase">{eyebrow}</p>}
            <h1 className="mt-1 text-4xl font-extrabold tracking-[-0.03em] text-white">{title}</h1>
            {desc && <p className="mt-1.5 max-w-2xl text-sm text-ink/75">{desc}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </UnsplashLayer>
  );
}
