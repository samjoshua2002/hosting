// Banner photos from Unsplash, same approach as the Chatter OS (instagram) app:
// one search for smooth abstract waves, filtered so busy scenes and flat colour washes are dropped,
// cached for a day so the 50-calls-per-hour key is never a problem.
import { cacheLife } from "next/cache";
import type { BannerPhoto } from "./types";

/** Art styles that suit the UI. Every page load picks one; each is one cached Unsplash search a day. */
export const STYLES = {
  // dark theme: deep, moody art that sits behind light text
  oil: "dark abstract oil painting",
  art: "neon abstract dark background",
  render: "dark 3d render abstract",
  fluid: "dark fluid art",
  waves: "dark gradient waves",
  // light theme: bright, airy art that sits behind dark text
  pastel: "pastel abstract gradient",
  airy: "white 3d render abstract",
  soft: "pastel fluid art",
  pearl: "iridescent holographic abstract",
  bloom: "light pastel abstract waves",
} as const;
export type Style = keyof typeof STYLES;
export const DARK_STYLES: Style[] = ["oil", "art", "render", "fluid", "waves"];
export const LIGHT_STYLES: Style[] = ["pastel", "airy", "soft", "pearl", "bloom"];
export const UTM = "utm_source=hosting_control&utm_medium=referral";

// Real-world scenes the colour searches sometimes return: we want abstract gradient art only.
const SCENE =
  /\b(sand|beach|sea|ocean|shore|fur|trees?|forest|mountains?|landscape|sky|person|people|woman|man|hand|building|city|room|text|letter|chair|furniture|book|umbrella|lemon|fruit|food|phone|laptop|screen|wall|tile|brain)\b/i;

interface RawPhoto {
  id?: string;
  likes?: number;
  color?: string;
  alt_description?: string | null;
  description?: string | null;
  urls?: { raw?: string };
  user?: { name?: string; links?: { html?: string } };
  links?: { html?: string };
}

const isPhotoUrl = (u: unknown): u is string => typeof u === "string" && /^https:\/\/images\.unsplash\.com\//.test(u);

/** Saturation (0-1) of Unsplash's dominant colour: grey and washed-out photos make dull banners. */
function saturation(hex: string | undefined): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return 0;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

/** Lightness (0-1) of Unsplash's dominant colour. */
function lightness(hex: string | undefined): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return 0.5;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

function isDull(p: RawPhoto, light: boolean): boolean {
  const text = `${p.alt_description ?? ""} ${p.description ?? ""}`;
  if (SCENE.test(text) || /black and white|monochrome|grayscale|greyscale|computer generated image of a/i.test(text)) return true;
  if ((p.likes ?? 0) < 20) return true;
  // light art is pastel (low saturation is fine) and must be bright; dark art must be vivid and dark
  return light ? lightness(p.color) < 0.55 || saturation(p.color) < 0.12 : lightness(p.color) > 0.45 || saturation(p.color) < 0.3;
}

/**
 * Top photos for one art style, cached by Next ("use cache") for a day: 5 styles → at most 5 Unsplash calls a day.
 * Throws on failure so an error is never cached.
 */
export async function getBannerPhotos(style: Style = "art"): Promise<BannerPhoto[]> {
  "use cache";
  cacheLife("days");

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return [];
  const params = new URLSearchParams({ query: STYLES[style], per_page: "30", orientation: "landscape", content_filter: "high" });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  const { results } = (await res.json()) as { results?: RawPhoto[] };
  const valid = (results ?? []).filter((p) => p?.id && isPhotoUrl(p.urls?.raw));
  // most-liked first: a good proxy for "looks amazing"
  const light = LIGHT_STYLES.includes(style);
  const vivid = valid.filter((p) => !isDull(p, light)).sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  const photos = (vivid.length >= 5 ? vivid : valid).slice(0, 24).map((p) => ({
    id: String(p.id),
    raw: p.urls!.raw!,
    color: p.color ?? null,
    alt: p.alt_description ?? "",
    author: p.user?.name ?? "Unsplash",
    authorUrl: p.user?.links?.html ?? "https://unsplash.com",
    link: p.links?.html ?? "https://unsplash.com",
  }));
  if (!photos.length) throw new Error("Unsplash returned no usable photos");
  return photos;
}
