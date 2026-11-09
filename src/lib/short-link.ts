/** The short, readable link for a project: <this site>/go/<name>. Browser-only. */
export function shortLink(name: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/go/${name}`;
}

/** How a short link reads on screen: host/go/name without https://. */
export function shortLabel(name: string): string {
  return shortLink(name).replace(/^https?:\/\//, "");
}
