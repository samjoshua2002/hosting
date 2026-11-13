"use client";

// Voice mode's centrepiece: ribbons of light that flow like water, in the colours of the day's cover photo (the
// theme hue). GSAP drives everything: the ribbons' height eases between states (calm while listening and rising
// with your voice, rolling while it thinks, swelling with its speech), and gsap.ticker draws each frame.
import gsap from "gsap";
import { useEffect, useRef } from "react";

interface Props {
  phase: string;
  /** 0..1 how loud you are (listening) */
  level?: number;
  width?: number;
  height?: number;
  /** a small version for the bar: fewer ribbons, no halo */
  mini?: boolean;
}

/** The theme hue from the page (it follows the Unsplash photo). */
function themeHue(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--h"));
  return Number.isFinite(v) ? v : 232;
}

export function VoiceWaves({ phase, level = 0, width = 620, height = 240, mini = false }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // what the drawing reads every frame; GSAP tweens these
  const s = useRef({ amp: 0.12, speed: 0.6, spread: 1, glow: 0.4, t: 0 });
  const phaseRef = useRef(phase);
  const levelRef = useRef(level);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  // ease between states
  useEffect(() => {
    const st = s.current;
    gsap.killTweensOf(st);
    let pulse: gsap.core.Tween | null = null;
    if (phase === "thinking" || phase === "starting") {
      gsap.to(st, { amp: 0.32, speed: 1.6, spread: 1.35, glow: 0.65, duration: 0.9, ease: "sine.inOut" });
    } else if (phase === "speaking") {
      gsap.to(st, { speed: 1.1, spread: 1, glow: 0.9, duration: 0.6, ease: "power2.out" });
      // organic swells while it talks
      const swell = () => {
        pulse = gsap.to(st, { amp: 0.45 + Math.random() * 0.45, duration: 0.18 + Math.random() * 0.28, ease: "sine.inOut", onComplete: swell });
      };
      swell();
    } else if (phase === "listening") {
      gsap.to(st, { amp: 0.14, speed: 0.7, spread: 1, glow: 0.45, duration: 0.6, ease: "power2.out" });
    } else {
      gsap.to(st, { amp: 0.05, speed: 0.4, spread: 1, glow: 0.2, duration: 0.8, ease: "power2.out" });
    }
    return () => {
      pulse?.kill();
    };
  }, [phase]);

  // draw
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = width * dpr;
    c.height = height * dpr;
    ctx.scale(dpr, dpr);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let hue = themeHue();
    let frame = 0;

    // each ribbon: its own hue offset, wavelength, speed and phase
    const ribbons = (mini ? [0, 40, -40] : [0, 38, -38, 80, -70]).map((dh, i) => ({
      dh,
      k: 1.6 + i * 0.55,
      sp: 0.8 + i * 0.27,
      ph: i * 1.7,
      a: 1 - i * 0.12,
    }));

    const draw = (_time: number, delta: number) => {
      const st = s.current;
      if (++frame % 60 === 0) hue = themeHue();
      // listening: your voice lifts the waves
      const live = phaseRef.current === "listening" ? st.amp + levelRef.current * 0.75 : st.amp;
      if (!reduced) st.t += (delta / 1000) * st.speed;
      const mid = height / 2;
      ctx.clearRect(0, 0, width, height);

      ctx.globalCompositeOperation = "lighter";
      for (const r of ribbons) {
        const amp = live * r.a * (height * 0.42);
        const path = (sign: 1 | -1) => {
          for (let x = 0; x <= width; x += 3) {
            const u = (x / width) * 2 - 1; // -1..1
            const bell = Math.pow(1 - u * u, 2.2); // calm at the edges, full in the middle
            const y = mid + sign * amp * bell * Math.sin(u * Math.PI * r.k * st.spread + st.t * r.sp * 2 + r.ph);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        };
        // a filled ribbon: the wave and its mirror, so it reads like a band of light
        ctx.beginPath();
        path(1);
        for (let x = width; x >= 0; x -= 3) {
          const u = (x / width) * 2 - 1;
          const bell = Math.pow(1 - u * u, 2.2);
          ctx.lineTo(x, mid - amp * 0.35 * bell * Math.sin(u * Math.PI * r.k * st.spread + st.t * r.sp * 2 + r.ph));
        }
        ctx.closePath();
        const fill = ctx.createLinearGradient(0, 0, width, 0);
        fill.addColorStop(0, `hsla(${hue + r.dh}, 90%, 62%, 0)`);
        fill.addColorStop(0.5, `hsla(${hue + r.dh}, 90%, 64%, ${mini ? 0.55 : 0.32})`);
        fill.addColorStop(1, `hsla(${hue + r.dh}, 90%, 62%, 0)`);
        ctx.fillStyle = fill;
        ctx.fill();
        // a bright thread along its crest
        ctx.beginPath();
        path(1);
        const line = ctx.createLinearGradient(0, 0, width, 0);
        line.addColorStop(0, `hsla(${hue + r.dh}, 100%, 80%, 0)`);
        line.addColorStop(0.5, `hsla(${hue + r.dh}, 100%, 86%, ${mini ? 0.9 : 0.75})`);
        line.addColorStop(1, `hsla(${hue + r.dh}, 100%, 80%, 0)`);
        ctx.strokeStyle = line;
        ctx.lineWidth = mini ? 1.2 : 1.6;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    };

    gsap.ticker.add(draw);
    return () => gsap.ticker.remove(draw);
  }, [width, height, mini]);

  // the halo lives outside the canvas (a blurred layer that fades out on every side), so there's never an edge
  const glow = phase === "speaking" ? 0.85 : phase === "thinking" || phase === "starting" ? 0.6 : phase === "listening" ? 0.4 + level * 0.4 : 0.2;
  return (
    <div className="relative" style={{ width, height }}>
      {!mini && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 size-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl transition-opacity duration-700"
          style={{ opacity: glow, background: "radial-gradient(closest-side, hsl(var(--h) 80% 60% / .35), hsl(calc(var(--h) + 30) 80% 50% / .12) 60%, transparent)" }}
        />
      )}
      <canvas ref={canvas} aria-hidden style={{ width, height }} className="relative block max-w-full" />
    </div>
  );
}
