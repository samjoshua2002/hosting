import type { NextRequest } from "next/server";
import { handle } from "@/lib/api";
import { getBannerPhotos, STYLES, type Style } from "@/lib/unsplash";

/** GET /api/banner?style=oil: cached Unsplash art for one style. Public (the login page uses it); [] on any failure. */
export const GET = handle(async (req: NextRequest) => {
  const asked = req.nextUrl.searchParams.get("style") ?? "art";
  const style = (asked in STYLES ? asked : "art") as Style;
  try {
    return Response.json({ style, photos: await getBannerPhotos(style) });
  } catch (e) {
    console.warn("[unsplash]", (e as Error).message);
    return Response.json({ style, photos: [] });
  }
});
