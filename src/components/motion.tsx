"use client";

// The app's motion, in one place (GSAP). Pages ease in on every navigation; cards, rows and chat messages rise in
// with a short stagger the moment they appear (also when data arrives later); the sidebar's highlight glides to the
// active page; the cover drifts as you scroll. Everything uses one easing family (expo.out) so it feels like one
// system, and nothing moves for people who ask their device for reduced motion.
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef, type ReactNode, type RefObject } from "react";

gsap.registerPlugin(useGSAP, ScrollTrigger);

export const EASE = "expo.out";
const REDUCED = "(prefers-reduced-motion: reduce)";
const reduced = () => typeof window !== "undefined" && window.matchMedia(REDUCED).matches;

/** What rises in when it appears. Add data-motion to anything else that should. */
const RISE = "[data-card], [data-motion]";

/** Rise in a group of elements that just appeared: the ones on screen now, the rest as they scroll into view. */
function rise(els: Element[]) {
  const fresh = els.filter((el) => !(el as HTMLElement).dataset.in) as HTMLElement[];
  if (!fresh.length) return;
  fresh.forEach((el) => (el.dataset.in = "1"));
  if (reduced()) return;
  const vh = window.innerHeight;
  const now = fresh.filter((el) => el.getBoundingClientRect().top < vh * 1.05);
  const later = fresh.filter((el) => !now.includes(el));
  // a big batch (a long chat opening) only animates its last few, quickly
  const animate = now.length > 14 ? now.slice(-14) : now;
  if (animate.length)
    gsap.fromTo(
      animate,
      { autoAlpha: 0, y: 16, scale: 0.985 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.8, ease: EASE, stagger: { each: 0.045, from: "start" }, clearProps: "transform,opacity,visibility" },
    );
  if (later.length) {
    // IntersectionObserver works in any scrolling box (the Assistant scrolls inside its own panel)
    gsap.set(later, { autoAlpha: 0, y: 22 });
    const io = new IntersectionObserver(
      (entries) => {
        const shown = entries.filter((e) => e.isIntersecting).map((e) => e.target);
        if (!shown.length) return;
        shown.forEach((t) => io.unobserve(t));
        gsap.to(shown, { autoAlpha: 1, y: 0, duration: 0.85, ease: EASE, stagger: 0.05, clearProps: "transform,opacity,visibility" });
      },
      { rootMargin: "0px 0px -4% 0px" },
    );
    later.forEach((el) => io.observe(el));
  }
}

/**
 * Wraps a page: it eases in on every navigation (key it by the path), and anything marked data-card / data-motion
 * inside rises in when it appears, including content that loads later.
 */
export function PageMotion({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const root = ref.current;
      if (!root) return;
      if (!reduced()) gsap.fromTo(root, { autoAlpha: 0, y: 8, filter: "blur(6px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.6, ease: EASE, clearProps: "filter,transform,opacity,visibility" });
      rise([...root.querySelectorAll(RISE)]);
      // content that arrives later (fetches, new chat messages)
      let queued: Element[] = [];
      let raf = 0;
      const obs = new MutationObserver((muts) => {
        for (const m of muts)
          for (const n of m.addedNodes) {
            if (!(n instanceof HTMLElement)) continue;
            if (n.matches(RISE)) queued.push(n);
            queued.push(...n.querySelectorAll(RISE));
          }
        if (queued.length && !raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            const batch = queued;
            queued = [];
            rise(batch);
          });
      });
      obs.observe(root, { childList: true, subtree: true });
      return () => {
        obs.disconnect();
        cancelAnimationFrame(raf);
      };
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** A highlight that glides to whichever child has data-active="true" (the sidebar's current page). */
export function useGlide(container: RefObject<HTMLElement | null>, pill: RefObject<HTMLElement | null>, dep: unknown) {
  const placed = useRef(false);
  useGSAP(
    () => {
      const box = container.current;
      const p = pill.current;
      if (!box || !p) return;
      const el = box.querySelector<HTMLElement>('[data-active="true"]');
      if (!el) {
        gsap.to(p, { autoAlpha: 0, duration: 0.2 });
        return;
      }
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const to = { x: r.left - b.left, y: r.top - b.top + box.scrollTop, width: r.width, height: r.height };
      const first = !placed.current;
      placed.current = true;
      if (first || reduced()) gsap.set(p, { ...to, autoAlpha: 1 });
      else gsap.to(p, { ...to, autoAlpha: 1, duration: 0.5, ease: EASE });
    },
    { dependencies: [dep] },
  );
}

/** The page cover drifts and fades a little as you scroll (Apple-style parallax). */
export function useParallax(target: RefObject<HTMLElement | null>, dep: unknown) {
  useGSAP(
    () => {
      const el = target.current;
      if (!el || reduced()) return;
      const t = gsap.to(el, { yPercent: 18, autoAlpha: 0.35, ease: "none", scrollTrigger: { start: 0, end: 420, scrub: 0.6 } });
      return () => {
        t.scrollTrigger?.kill();
        t.kill();
      };
    },
    { dependencies: [dep] },
  );
}
