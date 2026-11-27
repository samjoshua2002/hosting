// Website capture for cloning: a real browser (headless Chrome + Puppeteer, in Docker on a fleet machine) opens a
// site, scrolls it so lazy content loads, and returns in ONE call what a rebuild needs: the page's sections in
// order (headings, text, buttons, images, layout, backgrounds), the design tokens (fonts, colours, CSS variables,
// radii, spacing), navigation, footer, forms, the other pages it links to, and desktop + mobile screenshots.
// compareSites screenshots the original and the clone side by side so a vision model can list the differences.
import type { VmConfig } from "./config";
import { run, shq, withVm } from "./ssh";

const IMAGE = "zenika/alpine-chrome:with-puppeteer";

/** The Puppeteer script that runs inside the container. Prints one JSON object on stdout. */
const SCRIPT = String.raw`
const puppeteer = require("puppeteer");
const [, , mode, A, B] = process.argv;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, url, w, h, mobile) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: 1 });
  await p.setUserAgent(mobile ? UA.replace("Macintosh; Intel Mac OS X 10_15_7", "iPhone; CPU iPhone OS 17_0 like Mac OS X") + " Mobile" : UA);
  let status = 0, error = "";
  try {
    const res = await p.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    status = res ? res.status() : 0;
  } catch (e) { error = String(e.message || e).slice(0, 200); }
  // dismiss cookie banners that cover the page
  await p.evaluate(() => {
    const re = /^(accept|accept all|allow all|agree|i agree|got it|ok|okay)$/i;
    for (const b of document.querySelectorAll("button, a[role=button]")) if (re.test((b.textContent || "").trim())) { try { b.click(); } catch {} break; }
  }).catch(() => {});
  // scroll to the bottom slowly so lazy images and on-scroll animations load, then back to the top
  await p.evaluate(async () => {
    await new Promise((done) => {
      let y = 0;
      const t = setInterval(() => {
        window.scrollBy(0, 500); y += 500;
        if (y >= document.documentElement.scrollHeight || y > 24000) { clearInterval(t); window.scrollTo(0, 0); done(); }
      }, 100);
    });
  }).catch(() => {});
  await sleep(1200);
  return { p, status, error };
}

async function shots(p, w, max, chunk) {
  const H = await p.evaluate(() => Math.min(document.documentElement.scrollHeight, 24000)).catch(() => chunk);
  const list = [];
  for (let y = 0; y < H && list.length < max; y += chunk) {
    try {
      const buf = await p.screenshot({ type: "jpeg", quality: 62, clip: { x: 0, y, width: w, height: Math.min(chunk, H - y) }, captureBeyondViewport: true });
      list.push({ y, b64: Buffer.from(buf).toString("base64") });
    } catch (e) { break; }
  }
  return { height: H, shots: list };
}

// everything a rebuild needs, read from the live DOM and computed styles
function extract() {
  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ""; } };
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = cs(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const count = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + " (" + v + ")");

  const fonts = new Map(), colors = new Map(), bgs = new Map(), radii = new Map(), sizes = new Map();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const s = cs(el);
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) { count(fonts, s.fontFamily.split(",")[0].replace(/["']/g, "").trim()); count(colors, s.color); count(sizes, s.fontSize + "/" + s.fontWeight); }
    if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") count(bgs, s.backgroundColor);
    if (s.borderRadius && s.borderRadius !== "0px") count(radii, s.borderRadius);
  }
  const vars = [];
  try {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) if (r.selectorText === ":root" && r.style) for (const name of r.style) if (name.startsWith("--") && vars.length < 80) vars.push(name + ": " + r.style.getPropertyValue(name).trim());
    }
  } catch {}
  const fontLinks = [...document.querySelectorAll('link[href*="fonts.googleapis"], link[href*="use.typekit"], link[href*="fonts.bunny"]')].map((l) => l.href).slice(0, 5);

  const el2 = (e) => {
    const s = cs(e);
    const r = e.getBoundingClientRect();
    const heads = [...e.querySelectorAll("h1,h2,h3,h4")].filter(visible).slice(0, 8).map((h) => h.tagName.toLowerCase() + ": " + clip(h.textContent, 140));
    const paras = [...e.querySelectorAll("p, li, blockquote")].filter(visible).map((x) => clip(x.textContent, 220)).filter((t) => t.length > 2);
    const buttons = [...e.querySelectorAll("a, button")].filter(visible).map((b) => ({ text: clip(b.textContent || b.getAttribute("aria-label"), 60), href: b.href || "", btn: /btn|button/i.test(b.className) || b.tagName === "BUTTON" || (cs(b).backgroundColor !== "rgba(0, 0, 0, 0)" && cs(b).paddingLeft !== "0px") })).filter((b) => b.text).slice(0, 14);
    const imgs = [...e.querySelectorAll("img, svg, video, picture source")].filter(visible).slice(0, 10).map((i) => {
      const rr = i.getBoundingClientRect();
      if (i.tagName === "svg" || i.tagName === "SVG") return { kind: "svg", w: Math.round(rr.width), h: Math.round(rr.height), label: clip(i.getAttribute("aria-label") || "", 40) };
      return { kind: i.tagName.toLowerCase(), src: abs(i.currentSrc || i.src || i.getAttribute("srcset") || ""), alt: clip(i.alt, 80), w: Math.round(rr.width), h: Math.round(rr.height) };
    });
    // layout: how many columns the biggest row of children forms
    let cols = 1;
    for (const c of e.querySelectorAll("*")) {
      const d = cs(c).display;
      if ((d === "grid" || d === "flex") && c.children.length > 1 && c.getBoundingClientRect().width > r.width * 0.6) {
        const ys = new Map(); for (const k of c.children) { const ky = Math.round(k.getBoundingClientRect().top / 10); ys.set(ky, (ys.get(ky) || 0) + 1); }
        cols = Math.max(cols, ...ys.values());
      }
    }
    return {
      tag: e.tagName.toLowerCase(), id: e.id || undefined, cls: clip(typeof e.className === "string" ? e.className : "", 80) || undefined,
      y: Math.round(r.top + scrollY), h: Math.round(r.height),
      bg: s.backgroundColor !== "rgba(0, 0, 0, 0)" ? s.backgroundColor : undefined,
      bgImage: s.backgroundImage && s.backgroundImage !== "none" ? clip(s.backgroundImage, 200) : undefined,
      color: s.color, align: s.textAlign, padding: s.paddingTop + " " + s.paddingRight, columns: cols,
      headings: heads, text: paras.slice(0, 8), more_text: paras.length > 8 ? paras.length - 8 : undefined, links: buttons, images: imgs,
    };
  };

  // the page's sections: children of <main> or <body> (unwrapping single wrappers) that are tall enough to matter
  let root = document.querySelector("main") || document.body;
  for (let i = 0; i < 4; i++) { const kids = [...root.children].filter(visible); if (kids.length === 1 && kids[0].children.length > 1) root = kids[0]; else break; }
  const blocks = [];
  const header = document.querySelector("header, [role=banner], nav");
  if (header && visible(header)) blocks.push({ role: "header", ...el2(header) });
  for (const k of root.children) {
    if (!visible(k) || k === header || k.contains(header)) continue;
    if (k.getBoundingClientRect().height < 60) continue;
    if (/^(script|style|noscript)$/i.test(k.tagName)) continue;
    blocks.push({ role: k.tagName === "FOOTER" ? "footer" : "section", ...el2(k) });
    if (blocks.length >= 32) break;
  }
  const footer = document.querySelector("footer");
  if (footer && visible(footer) && !blocks.some((b) => b.role === "footer")) blocks.push({ role: "footer", ...el2(footer) });

  const navLinks = header ? [...header.querySelectorAll("a")].filter(visible).map((a) => ({ text: clip(a.textContent || a.getAttribute("aria-label"), 40), href: a.href })).filter((a) => a.text).slice(0, 20) : [];
  const forms = [...document.querySelectorAll("form")].slice(0, 5).map((f) => ({
    action: f.getAttribute("action") || "", method: (f.method || "get").toLowerCase(),
    fields: [...f.querySelectorAll("input, textarea, select")].filter((x) => x.type !== "hidden").slice(0, 12).map((x) => ({ name: x.name, type: x.type || x.tagName.toLowerCase(), placeholder: clip(x.placeholder, 50), label: clip(x.labels && x.labels[0] ? x.labels[0].textContent : "", 50) })),
    submit: clip((f.querySelector("button, input[type=submit]") || {}).textContent || (f.querySelector("input[type=submit]") || {}).value, 40),
  }));
  const pages = [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => { try { const u = new URL(h); return u.origin === location.origin && !/\.(pdf|zip|png|jpe?g|svg|mp4)$/i.test(u.pathname) && !u.hash; } catch { return false; } }).map((h) => h.split("#")[0]))].slice(0, 40);
  const tech = [];
  if (window.__NEXT_DATA__ || document.querySelector("#__next, script[src*='/_next/']")) tech.push("Next.js");
  if (document.querySelector("[data-reactroot], #root")) tech.push("React");
  if (window.__NUXT__ || document.querySelector("#__nuxt")) tech.push("Nuxt/Vue");
  if (document.querySelector("[class*='wp-'], link[href*='wp-content']")) tech.push("WordPress");
  if ([...document.querySelectorAll("[class]")].slice(0, 400).some((e) => /\b(px|py|mt|mb|text|bg|flex|grid)-[a-z0-9]/.test(String(e.className)))) tech.push("Tailwind-like utility classes");
  if (document.querySelector("[data-framer-name], [class*='framer-']")) tech.push("Framer");
  if (document.querySelector("[class*='w-'][data-wf-page], html[data-wf-site]")) tech.push("Webflow");
  // assets: every image, background image, video and font file the page uses (absolute URLs)
  const assets = new Map();
  const add = (u, kind, extra) => { const a = abs(u); if (a && /^https?:/.test(a) && !assets.has(a) && assets.size < 150) assets.set(a, { url: a, kind, ...(extra || {}) }); };
  for (const i of document.querySelectorAll("img")) { const r = i.getBoundingClientRect(); add(i.currentSrc || i.src, "image", { alt: clip(i.alt, 60), w: Math.round(r.width), h: Math.round(r.height) }); }
  for (const v of document.querySelectorAll("video")) { add(v.currentSrc || v.src || (v.querySelector("source") || {}).src, "video"); if (v.poster) add(v.poster, "image"); }
  for (const el of document.querySelectorAll("body *")) { const bi = cs(el).backgroundImage; if (bi && bi !== "none") for (const m of bi.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(m[1], "background"); }
  try {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) if (r.type === 5 && r.style) { const src = r.style.getPropertyValue("src") || ""; const m = src.match(/url\(["']?([^"')]+)["']?\)/); if (m) add(new URL(m[1], sheet.href || location.href).href, "font", { family: (r.style.getPropertyValue("font-family") || "").replace(/["']/g, ""), weight: r.style.getPropertyValue("font-weight") }); }
    }
  } catch {}
  // inline SVG icons and logos: the markup itself, so they can be reused exactly
  const svgs = [], seenSvg = new Set();
  for (const g of document.querySelectorAll("svg")) {
    if (!visible(g) || g.closest("svg") !== g) continue;
    const html = g.outerHTML.replace(/\s+/g, " ");
    if (html.length > 7000 || seenSvg.has(html)) continue;
    seenSvg.add(html);
    const r = g.getBoundingClientRect();
    const near = g.closest("a, button");
    svgs.push({ w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + scrollY), label: clip(g.getAttribute("aria-label") || (near ? near.getAttribute("aria-label") || near.textContent : ""), 40), svg: html });
    if (svgs.length >= 40) break;
  }
  // motion: CSS animations and transitions the browser is running or has declared, and the animation libraries in use
  const sel = (el) => { if (!el || !el.tagName) return ""; if (el.id) return "#" + el.id; const c = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""; return el.tagName.toLowerCase() + (c ? "." + c : ""); };
  const anims = [];
  try {
    for (const an of document.getAnimations().slice(0, 60)) {
      const t = an.effect && an.effect.getTiming ? an.effect.getTiming() : {};
      const kf = an.effect && an.effect.getKeyframes ? an.effect.getKeyframes() : [];
      anims.push({ type: an.constructor.name, name: an.animationName || an.transitionProperty || an.id || "", target: sel(an.effect && an.effect.target), duration: t.duration, delay: t.delay, easing: t.easing, iterations: t.iterations, direction: t.direction, fill: t.fill, keyframes: kf.slice(0, 4).map((k) => { const o = {}; for (const [kk, vv] of Object.entries(k)) if (!["computedOffset", "composite"].includes(kk)) o[kk] = typeof vv === "string" ? vv.slice(0, 80) : vv; return o; }) });
    }
  } catch {}
  const keyframeNames = [];
  try { for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules; } catch { continue; } for (const r of rules) if (r.type === 7 && keyframeNames.length < 40) keyframeNames.push(r.name + ": " + clip(r.cssText, 300)); } } catch {}
  let transitions = 0; const transitionSamples = [];
  for (const el of document.querySelectorAll("a, button, [class*=card], [class*=btn], img, li")) { const s = cs(el); if (s.transitionDuration && s.transitionDuration !== "0s") { transitions++; if (transitionSamples.length < 12) transitionSamples.push(sel(el) + ": " + s.transitionProperty + " " + s.transitionDuration + " " + s.transitionTimingFunction); } }
  const libs = [];
  if (window.gsap || window.TweenMax) libs.push("GSAP" + (window.ScrollTrigger ? " + ScrollTrigger" : ""));
  if (document.querySelector("[data-framer-appear-id], [data-projection-id], [style*='--framer']")) libs.push("Framer Motion");
  if (window.lottie || window.bodymovin || document.querySelector("lottie-player, dotlottie-player")) libs.push("Lottie");
  if (window.THREE || document.querySelector("canvas[data-engine*='three']")) libs.push("three.js");
  if (document.querySelector("canvas")) libs.push(document.querySelectorAll("canvas").length + " canvas element(s)");
  if (window.lenis || document.documentElement.classList.contains("lenis")) libs.push("Lenis smooth scroll");
  if (window.Swiper || document.querySelector(".swiper")) libs.push("Swiper carousel");
  if (document.querySelector("[data-aos]")) libs.push("AOS scroll reveal");
  if (window.anime) libs.push("anime.js");
  if (document.querySelector("spline-viewer, canvas[id*='spline']")) libs.push("Spline 3D");
  const motion = { libraries: libs, running: anims, keyframes: keyframeNames, transitions: { count: transitions, samples: transitionSamples }, reducedMotionQuery: matchMedia("(prefers-reduced-motion: reduce)").matches };
  const meta = (n) => (document.querySelector('meta[name="' + n + '"], meta[property="' + n + '"]') || {}).content || "";
  return {
    url: location.href, title: document.title, description: meta("description") || meta("og:description"), lang: document.documentElement.lang,
    favicon: abs((document.querySelector("link[rel*=icon]") || {}).href || "/favicon.ico"), ogImage: meta("og:image"), tech,
    design: { fonts: top(fonts, 6), fontLinks, textColors: top(colors, 8), backgrounds: top(bgs, 10), textSizes: top(sizes, 10), radii: top(radii, 5), cssVariables: vars },
    nav: navLinks, sections: blocks, forms, pages, height: document.documentElement.scrollHeight,
    motion, assets: [...assets.values()], svgs,
    // a page that is mostly one embedded frame (template viewers like Wix, Webflow and ThemeForest previews): the real site is inside it
    frames: [...document.querySelectorAll("iframe")].map((f) => { const r = f.getBoundingClientRect(); return { src: abs(f.src || ""), w: Math.round(r.width), h: Math.round(r.height), share: Math.round((100 * Math.max(0, r.width) * Math.max(0, Math.min(r.height, innerHeight))) / (innerWidth * innerHeight)) }; }).filter((f) => /^https?:/.test(f.src) && f.src !== location.href).sort((a, b) => b.share - a.share).slice(0, 5),
  };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--ignore-certificate-errors"] });
  const out = {};
  try {
    if (mode === "capture") {
      const extra = B ? JSON.parse(Buffer.from(B, "base64").toString()) : [];
      const d = await open(browser, A, 1440, 900);
      out.status = d.status; out.error = d.error;
      out.spec = await d.p.evaluate(extract);
      out.desktop = await shots(d.p, 1440, 8, 1600);
      await d.p.close();
      const m = await open(browser, A, 390, 844, true);
      out.mobile = await shots(m.p, 390, 3, 1400);
      await m.p.close();
      out.subpages = [];
      for (const u of extra.slice(0, 4)) {
        const s = await open(browser, u, 1440, 900);
        const spec = await s.p.evaluate(extract).catch(() => null);
        const top = await shots(s.p, 1440, 1, 1600);
        out.subpages.push({ url: u, status: s.status, error: s.error, spec, shot: top.shots[0] });
        await s.p.close();
      }
    } else if (mode === "compare") {
      const pair = [];
      for (const u of [A, B]) { const d = await open(browser, u, 1440, 900); pair.push({ url: u, status: d.status, error: d.error, ...(await shots(d.p, 1440, 4, 1200)) }); await d.p.close(); }
      // side by side: original left, clone right, one image per 1200px band
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 600, deviceScaleFactor: 1 });
      out.bands = [];
      const n = Math.max(pair[0].shots.length, pair[1].shots.length);
      for (let i = 0; i < n; i++) {
        const img = (s) => (s ? '<img src="data:image/jpeg;base64,' + s.b64 + '" style="width:720px;display:block">' : '<div style="width:720px;height:600px;background:#eee;font:20px sans-serif;display:flex;align-items:center;justify-content:center">(page ends)</div>');
        await page.setContent('<body style="margin:0;display:flex;gap:0;background:#fff"><div style="border-right:4px solid red">' + img(pair[0].shots[i]) + "</div><div>" + img(pair[1].shots[i]) + "</div></body>", { waitUntil: "load" });
        const h = await page.evaluate(() => document.body.scrollHeight);
        const buf = await page.screenshot({ type: "jpeg", quality: 62, clip: { x: 0, y: 0, width: 1444, height: Math.min(h, 1400) }, captureBeyondViewport: true });
        out.bands.push(Buffer.from(buf).toString("base64"));
      }
      out.meta = pair.map((p) => ({ url: p.url, status: p.status, error: p.error, height: p.height }));
    }
  } catch (e) {
    out.fatal = String(e.message || e).slice(0, 300);
  }
  await browser.close().catch(() => {});
  process.stdout.write(JSON.stringify(out));
})();
`;

async function runScript(vm: VmConfig, args: string[]): Promise<Record<string, unknown>> {
  const cmd = [
    'D="$HOME/.hosting/capture"; mkdir -p "$D"; cat > "$D/capture.js"',
    `docker image inspect ${IMAGE} >/dev/null 2>&1 || docker pull -q ${IMAGE} >/dev/null 2>&1`,
    `timeout 290 docker run --rm --shm-size=1g --entrypoint node -w /usr/src/app -v "$D/capture.js":/usr/src/app/capture.js:ro ${IMAGE} capture.js ${args.map(shq).join(" ")}`,
  ].join("; ");
  const r = await withVm(vm, (c) => run(c, cmd, { stdin: SCRIPT, timeoutMs: 330_000, maxBytes: 40 * 1024 * 1024 }));
  const text = r.stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`the browser on ${vm.name} returned nothing${r.stderr ? `: ${r.stderr.slice(-300)}` : ""}`);
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    throw new Error(`the browser output was cut off${r.truncated ? " (too large)" : ""}`);
  }
}

export interface Shot {
  y: number;
  b64: string;
}
export interface Capture {
  status?: number;
  error?: string;
  fatal?: string;
  spec?: Record<string, unknown>;
  desktop?: { height: number; shots: Shot[] };
  mobile?: { height: number; shots: Shot[] };
  subpages?: { url: string; status?: number; error?: string; spec?: Record<string, unknown> | null; shot?: Shot }[];
}

/** Open url (and up to 4 more pages of the same site) in a real browser and capture everything a rebuild needs. */
export async function captureSite(vm: VmConfig, url: string, pages: string[] = []): Promise<Capture> {
  return (await runScript(vm, ["capture", url, Buffer.from(JSON.stringify(pages.slice(0, 4))).toString("base64")])) as Capture;
}

/** Screenshot two sites at the same size and put them side by side (original left, clone right), in bands. */
export async function compareSites(vm: VmConfig, original: string, clone: string): Promise<{ bands: string[]; meta?: { url: string; status?: number; error?: string; height?: number }[]; fatal?: string }> {
  return (await runScript(vm, ["compare", original, clone])) as { bands: string[]; meta?: { url: string; status?: number; error?: string; height?: number }[]; fatal?: string };
}
