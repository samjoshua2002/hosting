// Banner photos from Unsplash, same approach as the Chatter OS (instagram) app:
// one search for smooth abstract waves, filtered so busy scenes and flat colour washes are dropped,
// cached for a day so the 50-calls-per-hour key is never a problem.
import { cacheLife } from "next/cache";
import type { BannerPhoto } from "./types";

const QUERY = "smooth abstract waves";
export const UTM = "utm_source=hosting_control&utm_medium=referral";

const PLAIN = /\b(gradients?|blur|blurred|blurry|bokeh|plain|solid colou?r)\b/i;
const TEXTURED = /\b(waves?|wavy|patterns?|textures?|lines?|stripes?|swirls?|curves?|ripples?|folds?|silk)\b/i;
const SCENE = /\b(sand|beach|sea|ocean|shore|water|fur|trees?|forest|mountains?|sky|person|woman|man)\b/i;

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

function isPlain(p: RawPhoto): boolean {
  const text = `${p.alt_description ?? ""} ${p.description ?? ""}`;
  if (SCENE.test(text) || /black and white|monochrome|grayscale|greyscale/i.test(text)) return true;
  return PLAIN.test(text) && !TEXTURED.test(text);
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
  const textured = valid.filter((p) => !isPlain(p));
  const photos = (textured.length >= 5 ? textured : valid).map((p) => ({
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
