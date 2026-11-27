// A web page the user saved from their own browser (Save Page As, or a mirror tool), turned back into a page that
// loads from the original servers: every relative link, image, stylesheet, script and url() points at the real
// address again. Used when a site blocks automated browsers (bot checks) but the user can open and save it.

/** "../cdn.example.com/a/b.css" (a saved mirror's folder per host) or a path relative to the page → a full URL. */
function absolute(u: string, pageUrl: string): string {
  const v = u.trim();
  if (!v || /^(data:|blob:|mailto:|tel:|#|javascript:|about:)/i.test(v)) return u;
  if (v.startsWith("//")) return `https:${v}`;
  if (/^https?:/i.test(v)) return v;
  const mirrored = v.match(/^(?:\.\.\/|\.\/)*((?:[a-z0-9-]+\.)+[a-z]{2,})\/(.*)$/i);
  if (mirrored) return `https://${mirrored[1]}/${mirrored[2]}`;
  try {
    return new URL(v, pageUrl).href;
  } catch {
    return u;
  }
}

/** Every link in the saved HTML made absolute again; scripts are kept so the page's own animations run. */
export function restoreSavedPage(html: string, pageUrl: string): string {
  const fix = (u: string) => absolute(u, pageUrl);
  return html
    .replace(/\b(src|href|poster|data-src|data-href|action)=(["'])([^"']*)\2/gi, (_m, attr: string, q: string, u: string) => `${attr}=${q}${fix(u)}${q}`)
    .replace(/\b(srcset|data-srcset)=(["'])([^"']*)\2/gi, (_m, attr: string, q: string, v: string) =>
      `${attr}=${q}${v
        .split(",")
        .map((part) => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [fix(u), ...rest].join(" ");
        })
        .join(", ")}${q}`,
    )
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (_m, q: string, u: string) => `url(${q}${fix(u)}${q})`)
    .replace(/<!--\s*Mirrored from[\s\S]*?-->/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
}
