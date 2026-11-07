"use client";

// Every full page load picks a random Unsplash colour family and photo; the photo's colour becomes the app's hue.
// Client-side navigation keeps the same look; the shuffle button picks a new one.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { BannerPhoto } from "@/lib/types";

const UTM = "utm_source=hosting_control&utm_medium=referral";

/** Unsplash colour filters and the hue to fall back on when a photo's own colour is grey. */
export const TONES: Record<string, number> = { blue: 225, purple: 265, magenta: 310, red: 352, orange: 24, yellow: 46, green: 145, teal: 178 };

interface ThemeState {
  photo: BannerPhoto | null;
  tone: string | null;
  hue: number | null;
}

const SERVER: ThemeState = { photo: null, tone: null, hue: null };
let state: ThemeState = SERVER;
let started = false;
const listeners = new Set<() => void>();
const lists = new Map<string, Promise<BannerPhoto[]>>();

function set(next: ThemeState) {
  state = next;
  listeners.forEach((l) => l());
}

function photosFor(tone: string): Promise<BannerPhoto[]> {
  let p = lists.get(tone);
  if (!p) {
    p = fetch(`/api/banner?tone=${tone}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { photos: [] }))
      .then((d: { photos?: BannerPhoto[] }) => d.photos ?? [])
      .catch(() => []);
    lists.set(tone, p);
  }
  return p;
}

/** Hue (0-360) of a photo's dominant colour, or the tone's hue when the photo is too grey to say. */
export function hueOf(hex: string | null, fallback: number): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return fallback;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.22 || d < 0.06) return fallback;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return Math.round(h < 0 ? h + 360 : h);
}

function applyHue(h: number) {
  document.documentElement.style.setProperty("--h", String(h));
  try {
    localStorage.setItem("hosting.hue", String(h));
  } catch {
    /* storage unavailable */
  }
}

export async function shuffleTheme(): Promise<void> {
  const choices = Object.keys(TONES).filter((t) => t !== state.tone);
  const tone = choices[Math.floor(Math.random() * choices.length)];
  const list = await photosFor(tone);
  const others = list.filter((p) => p.id !== state.photo?.id);
  const photo = others.length ? others[Math.floor(Math.random() * others.length)] : null;
  const hue = hueOf(photo?.color ?? null, TONES[tone]);
  applyHue(hue);
  set({ photo, tone, hue });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme(): ThemeState {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  useEffect(() => {
    if (started) return;
    started = true;
    void shuffleTheme();
  }, []);
  return s;
}

/** Inline script for <head>: re-applies the last hue before first paint, so a refresh never flashes another colour. */
export const HUE_BOOT = `try{var h=localStorage.getItem("hosting.hue");if(h&&/^\\d{1,3}$/.test(h))document.documentElement.style.setProperty("--h",h)}catch(e){}`;

export function bannerSrc(photo: BannerPhoto | null, width = 1800): string | null {
  if (!photo) return null;
  return `${photo.raw}${photo.raw.includes("?") ? "&" : "?"}w=${width}&q=80&fm=jpg&fit=crop`;
}

/** Photo layer: themed artwork first, the photo fades in (grayscale + theme tint, so it always matches), then a shade. */
export function UnsplashLayer({ photo, className = "", children }: { photo: BannerPhoto | null; className?: string; children?: ReactNode }) {
  const src = bannerSrc(photo);
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <div className={`ub ${className}`} title={photo ? `Photo by ${photo.author} on Unsplash` : undefined}>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- Unsplash requires hotlinking images.unsplash.com
        <img key={src} src={src} alt="" decoding="async" className={`ub-img${loaded === src ? " in" : ""}`} onLoad={() => setLoaded(src)} />
      )}
      <span className={`ub-tint${loaded === src && src ? " in" : ""}`} aria-hidden />
      <span className="ub-shade" aria-hidden />
      {children}
    </div>
  );
}

export function PhotoCredit({ photo }: { photo: BannerPhoto | null }) {
  if (!photo) return null;
  return (
    <span className="text-[11px] text-muted">
      Theme from a photo by{" "}
      <a className="underline underline-offset-2 hover:text-white" href={`${photo.authorUrl}?${UTM}`} target="_blank" rel="noreferrer">
        {photo.author}
      </a>{" "}
      on{" "}
      <a className="underline underline-offset-2 hover:text-white" href={`https://unsplash.com/?${UTM}`} target="_blank" rel="noreferrer">
        Unsplash
      </a>
    </span>
  );
}
