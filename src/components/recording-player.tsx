"use client";

import { Download, Loader2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * A scroll recording from capture_site, played like a video: the frames (JPEGs) are shown one after another, with
 * play/pause, a scrubber and speed. "GIF" turns the frames into an animated GIF in the browser (no server work).
 */
export function RecordingPlayer({ title, src, url }: { title: string; src: string; url?: string }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [making, setMaking] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // load only when it scrolls into view: a long chat may hold several recordings
  useEffect(() => {
    const el = box.current;
    if (!el || frames) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      fetch(src)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`couldn't load the recording (${r.status})`))))
        .then((d: { frames?: string[] }) => setFrames((d.frames ?? []).map((b) => `data:image/jpeg;base64,${b}`)))
        .catch((e: Error) => setError(e.message));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [src, frames]);

  useEffect(() => {
    if (!frames?.length || !playing) return;
    const t = setInterval(() => setI((x) => (x + 1) % frames.length), 220 / speed);
    return () => clearInterval(t);
  }, [frames, playing, speed]);

  const gif = async () => {
    if (!frames?.length) return;
    setMaking(true);
    try {
      const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
      const imgs = await Promise.all(
        frames.map(
          (f) =>
            new Promise<HTMLImageElement>((res, rej) => {
              const im = new Image();
              im.onload = () => res(im);
              im.onerror = () => rej(new Error("frame failed to load"));
              im.src = f;
            }),
        ),
      );
      const w = imgs[0].naturalWidth;
      const h = imgs[0].naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const enc = GIFEncoder();
      for (const im of imgs) {
        ctx.drawImage(im, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const palette = quantize(data, 256);
        enc.writeFrame(applyPalette(data, palette), w, h, { palette, delay: 220 });
        await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      }
      enc.finish();
      const blob = new Blob([enc.bytes() as BlobPart], { type: "image/gif" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(url ?? title).replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "-").slice(0, 60)}.gif`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMaking(false);
    }
  };

  return (
    <figure ref={box} className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/30">
      <div className="relative aspect-[16/10] w-full bg-black/40">
        {frames?.length ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={frames[i]} alt={`${title}, frame ${i + 1} of ${frames.length}`} className="h-full w-full object-cover object-top" />
        ) : (
          <div className="grid h-full place-items-center text-xs text-zinc-500">{error ?? <Loader2 className="size-5 animate-spin" />}</div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2">
        <button type="button" onClick={() => setPlaying((p) => !p)} disabled={!frames?.length} className="grid size-7 place-items-center rounded-md text-zinc-300 hover:bg-white/[0.06] disabled:opacity-40" aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, (frames?.length ?? 1) - 1)}
          value={i}
          onChange={(e) => {
            setPlaying(false);
            setI(Number(e.target.value));
          }}
          disabled={!frames?.length}
          className="h-1 min-w-0 flex-1 accent-[var(--accent)]"
          aria-label="Position in the recording"
        />
        <button type="button" onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 0.5 : 1))} className="w-9 rounded-md px-1 text-[11px] tabular-nums text-zinc-400 hover:bg-white/[0.06]" aria-label="Playback speed">
          {speed}x
        </button>
        <button type="button" onClick={() => void gif()} disabled={!frames?.length || making} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.06] disabled:opacity-40" title="Download as an animated GIF">
          {making ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} GIF
        </button>
      </div>
      <figcaption className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2 text-xs text-zinc-400">
        <span className="truncate text-zinc-300">{title}</span>
        {frames && <span className="shrink-0 tabular-nums text-zinc-600">{frames.length} frames</span>}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-accent-soft hover:underline">
            open page
          </a>
        )}
      </figcaption>
    </figure>
  );
}
