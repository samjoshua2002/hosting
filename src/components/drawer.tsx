"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Drawer({
  title,
  subtitle,
  actions,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portaled to <body>: pages sit in an isolated stacking context (for the cover image), and the
  // drawer must cover the sticky top bar and sidebar too.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <button aria-label="Close" className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-3xl flex-col border-l border-[var(--line)] bg-[var(--panel)] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">{title}</div>
            {subtitle && <div className="mt-1 text-xs text-zinc-500">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button onClick={onClose} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-5">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
