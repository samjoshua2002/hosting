"use client";

import { Laptop } from "lucide-react";
import { useState } from "react";
import { UnsplashLayer, useTheme } from "./theme";

/** This is a laptop/desktop tool: below 1024px wide, show a notice instead of a cramped layout. */
export function ScreenGuard() {
  const { photo } = useTheme();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="fixed inset-0 z-[100] lg:hidden">
      <UnsplashLayer photo={photo} className="h-full w-full">
        <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
          <span className="grid size-16 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
            <Laptop className="size-8 text-white" />
          </span>
          <h1 className="text-2xl font-extrabold text-white">Open this on a laptop</h1>
          <p className="max-w-xs text-sm text-ink/80">The control panel is built for a wide screen: tables, the pipeline view and terminals need the room.</p>
          <button onClick={() => setDismissed(true)} className="mt-2 text-xs text-ink/60 underline underline-offset-2">
            Continue anyway
          </button>
        </div>
      </UnsplashLayer>
    </div>
  );
}
