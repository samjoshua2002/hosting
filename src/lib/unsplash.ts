// Banner photos from Unsplash, same approach as the Chatter OS (instagram) app:
// one search for smooth abstract waves, filtered so busy scenes and flat colour washes are dropped,
// cached for a day so the 50-calls-per-hour key is never a problem.
import { cacheLife } from "next/cache";
import type { BannerPhoto } from "./types";

const QUERY = "colorful gradient waves";
export const UTM = "utm_source=hosting_control&utm_medium=referral";

// Real-world scenes the colour searches sometimes return: we want abstract gradient art only.
const SCENE = /\b(sand|beach|sea|ocean|shore|water|fur|trees?|forest|mountains?|landscape|sky|person|woman|man|building|city|text|letter)\b/i;

interface RawPhoto {
  id?: string;
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

function isDull(p: RawPhoto): boolean {
  const text = `${p.alt_description ?? ""} ${p.description ?? ""}`;
  if (SCENE.test(text) || /black and white|monochrome|grayscale|greyscale|computer generated image of a/i.test(text)) return true;
  return saturation(p.color) < 0.3;
}

/** Cached across requests and instances by Next ("use cache"). Throws on failure so errors are never cached. */
export const TONES = ["blue", "purple", "magenta", "red", "orange", "yellow", "green", "teal"] as const;

/** One cached list per Unsplash colour filter (8 tones → at most 8 API calls a day). */
export async function getBannerPhotos(tone: (typeof TONES)[number] = "blue"): Promise<BannerPhoto[]> {
  "use cache";
  cacheLife("days");

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return [];
  const params = new URLSearchParams({ query: QUERY, per_page: "30", orientation: "landscape", content_filter: "high", color: tone });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  const { results } = (await res.json()) as { results?: RawPhoto[] };
  const valid = (results ?? []).filter((p) => p?.id && isPhotoUrl(p.urls?.raw));
  const vivid = valid.filter((p) => !isDull(p));
  const photos = (vivid.length >= 5 ? vivid : valid).map((p) => ({
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
