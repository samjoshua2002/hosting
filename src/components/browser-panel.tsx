"use client";

// The Assistant's in-app browser: links from the conversation open here first (like a side tab), at desktop or
// phone width; "open in new tab" when you want the real thing.
import { ArrowLeft, ArrowUpRight, Monitor, RotateCw, Smartphone, X } from "lucide-react";
import { useState } from "react";
import { cx } from "./ui";

export function BrowserPanel({ url, onClose, onBack }: { url: string; onClose: () => void; onBack?: () => void }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [nonce, setNonce] = useState(0);
  const [address, setAddress] = useState(url);
  const [current, setCurrent] = useState(url);
  const [loaded, setLoaded] = useState(false);
  if (url !== current && url !== address) {
    // a new link was clicked while the panel was open
    setCurrent(url);
    setAddress(url);
    setLoaded(false);
  }
  const go = () => {
    const u = /^https?:\/\//i.test(address) ? address : `https://${address}`;
    setCurrent(u);
    setAddress(u);
    setLoaded(false);
    setNonce((n) => n + 1);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-2 py-2">
        {onBack && (
          <button onClick={onBack} className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-white" title="Back to links" aria-label="Back">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <button
          onClick={() => {
            setLoaded(false);
            setNonce((n) => n + 1);
          }}
          className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-white"
          title="Reload"
          aria-label="Reload"
        >
          <RotateCw className="size-3.5" />
        </button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2.5 py-1 font-mono text-[11.5px] text-zinc-200 focus:border-white/20"
        />
        <div className="flex rounded-md border border-white/[0.08] p-0.5">
          {(
            [
              ["desktop", Monitor],
              ["mobile", Smartphone],
            ] as const
          ).map(([d, I]) => (
            <button key={d} onClick={() => setDevice(d)} className={cx("rounded p-1", device === d ? "bg-white/[0.1] text-white" : "text-zinc-500 hover:text-white")} title={d === "desktop" ? "Desktop" : "Mobile"} aria-label={d}>
              <I className="size-3.5" />
            </button>
          ))}
        </div>
        <a href={current} target="_blank" rel="noreferrer" className="grid size-7 place-items-center rounded-md text-zinc-400 hover:bg-white/[0.06] hover:text-white" title="Open in a new tab" aria-label="Open in a new tab">
          <ArrowUpRight className="size-4" />
        </a>
        <button onClick={onClose} className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-white" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <div className={cx("relative min-h-0 flex-1", device === "mobile" && "bg-[var(--sidebar)] px-3 py-4")}>
        {!loaded && <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-[var(--accent)]" />}
        <iframe
          key={`${current}-${nonce}`}
          title="Preview"
          src={current}
          onLoad={() => setLoaded(true)}
          // other sites run sandboxed: no access to the dashboard, its cookies or this window
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className={cx("h-full w-full border-0 bg-white", device === "mobile" && "mx-auto max-h-[760px] w-[390px] max-w-full rounded-[22px] shadow-2xl ring-1 ring-white/10")}
        />
        <p className="pointer-events-none absolute right-2 bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-[10.5px] text-zinc-300 opacity-80 backdrop-blur">
          Blank? Some sites refuse to be shown inside other pages: use ↗ to open it in a new tab.
        </p>
      </div>
    </div>
  );
}
