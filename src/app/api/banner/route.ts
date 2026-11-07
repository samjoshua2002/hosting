import type { NextRequest } from "next/server";
import { handle } from "@/lib/api";
import { getBannerPhotos, TONES } from "@/lib/unsplash";

/** GET /api/banner?tone=blue: cached Unsplash photos for one colour family. Public (the login page uses it); [] on any failure. */
export const GET = handle(async (req: NextRequest) => {
  const asked = req.nextUrl.searchParams.get("tone") ?? "blue";
  const tone = (TONES as readonly string[]).includes(asked) ? (asked as (typeof TONES)[number]) : "blue";
  try {
    return Response.json({ tone, photos: await getBannerPhotos(tone) });
  } catch (e) {
    console.warn("[unsplash]", (e as Error).message);
    return Response.json({ tone, photos: [] });
  }
});
