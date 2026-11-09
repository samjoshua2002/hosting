"use client";

import { DatabaseBackup, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Down {
  vm: string;
  until: string | null;
  copy: { vm: string; at: number; from: string } | null;
}

const ago = (t: number) => `${Math.max(1, Math.round((Date.now() - t) / 60_000))} min ago`;
const at = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Shown when the machine holding the dashboard's data is resting: wait for it (it disappears when the
 * machine is back), or carry on from the latest copy on another machine.
 */
export function StorageBanner() {
  const [down, setDown] = useState<Down | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Down>).detail;
      setDown({ vm: d.vm, until: d.until, copy: d.copy });
    };
    window.addEventListener("store-down", on);
    return () => window.removeEventListener("store-down", on);
  }, []);

  // while it's down, check every 30 s whether it's back (or a copy appeared)
  const check = useCallback(async () => {
    const s = await api<{ vm: string; ok: boolean; until: string | null; copy: Down["copy"] }>("/api/storage").catch(() => null);
    if (!s) return;
    if (s.ok) {
      setDown(null);
      setHidden(false);
    } else setDown({ vm: s.vm, until: s.until, copy: s.copy });
  }, []);
  useEffect(() => {
    if (!down) return;
    const t = setInterval(() => void check(), 30_000);
    return () => clearInterval(t);
  }, [down, check]);

  if (!down || hidden) return null;
  const switchTo = async () => {
    if (!down.copy) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/storage", { switchTo: down.copy.vm });
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="sticky top-12 z-20 flex items-start gap-3 border-b border-[var(--warning)]/30 bg-[#1a1408]/95 px-5 py-3 text-sm backdrop-blur">
      <DatabaseBackup className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <div className="min-w-0 flex-1">
        <p className="text-white">
          {down.vm}, which keeps the dashboard&apos;s data, is {down.until ? `cooling down until ${at(down.until)}` : "not reachable right now"}.
        </p>
        <p className="mt-0.5 text-xs text-zinc-400">
          {down.copy
            ? `Wait and everything comes back as it was, or carry on now from the copy on ${down.copy.vm} (made ${ago(down.copy.at)}; changes after that stay on ${down.vm}).`
            : "Wait and everything comes back as it was. There's no copy on another machine yet (Autopilot makes one every 15 minutes)."}
        </p>
        {err && <p className="mt-1 text-xs text-[var(--critical-text)]">{err}</p>}
      </div>
      {down.copy && (
        <button onClick={() => void switchTo()} disabled={busy} className="flex shrink-0 items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-white/90 disabled:opacity-60">
          {busy && <Loader2 className="size-3.5 animate-spin" />} Use {down.copy.vm}
        </button>
      )}
      <button onClick={() => setHidden(true)} className="shrink-0 rounded-md px-2 py-1.5 text-xs text-zinc-300 ring-1 ring-white/10 hover:bg-white/[0.06]">
        Wait
      </button>
    </div>
  );
}
