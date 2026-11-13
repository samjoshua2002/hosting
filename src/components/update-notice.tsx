"use client";

// A newer version went live while this tab was open: offer a reload (an open page keeps running the old code).
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

const BUILT = process.env.NEXT_PUBLIC_VERSION ?? "dev";

export function UpdateNotice() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (BUILT === "dev") return;
    const check = () =>
      fetch("/api/version", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { version?: string } | null) => {
          if (d?.version && d.version !== "dev" && d.version !== BUILT) setReady(true);
        })
        .catch(() => {});
    const t = setInterval(check, 120_000);
    window.addEventListener("focus", check);
    check();
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, []);
  if (!ready) return null;
  return (
    <button
      onClick={() => window.location.reload()}
      className="word-in fixed bottom-5 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[var(--pop)]/95 px-4 py-2 text-[13px] text-white shadow-xl shadow-black/40 backdrop-blur hover:bg-[var(--pop)]"
    >
      <RefreshCw className="size-3.5 text-[var(--accent)]" /> New version ready · Reload
    </button>
  );
}
