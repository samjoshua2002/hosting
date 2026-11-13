"use client";

// Voice mode: talk with the Assistant like a call. It listens (the browser's speech recognition), thinks with a
// fast advisor model that asks one question at a time, speaks back (speech synthesis), and once you agree to the
// plan it hands the full instruction to the Assistant in the chat. A soft glow breathes with your voice while it
// listens and warms up while it speaks.
import { AudioLines, Check, Loader2, Mic, MicOff, Play, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { cx } from "./ui";

type Phase = "starting" | "listening" | "thinking" | "speaking" | "paused" | "error";
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

interface Rec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export function voiceSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean((w.SpeechRecognition || w.webkitSpeechRecognition) && "speechSynthesis" in window);
}

/* ---------- voices and personality (remembered in this browser) ---------- */

export type Persona = "warm" | "professional" | "direct";
export const PERSONAS: { id: Persona; label: string; hint: string }[] = [
  { id: "warm", label: "Warm", hint: "friendly, encouraging" },
  { id: "professional", label: "Professional", hint: "calm consultant" },
  { id: "direct", label: "Direct", hint: "fewest words" },
];
interface VoicePrefs {
  voice?: string;
  persona: Persona;
  rate: number;
}
const PREFS = "hosting.voice";
function loadPrefs(): VoicePrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<VoicePrefs>;
    return { voice: p.voice, persona: PERSONAS.some((x) => x.id === p.persona) ? p.persona! : "warm", rate: typeof p.rate === "number" && p.rate !== 1.03 ? p.rate : 0.97 };
  } catch {
    return { persona: "warm", rate: 0.97 };
  }
}
function savePrefs(p: VoicePrefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    /* blocked */
  }
}

const FEMALE =
  /(Samantha|Ava|Allison|Susan|Victoria|Karen|Moira|Tessa|Fiona|Serena|Zoe|Kate|Veena|Lekha|Nicky|Joelle|Kathy|Vicki|Martha|Catherine|Shelley|Sandy|Flo|Grandma|Female|Microsoft (Aria|Jenny|Sonia|Libby|Natasha|Neerja|Clara|Emma|Michelle|Zira|Hazel|Heera))/i;
const MALE = /(Daniel|Alex\b|Fred|Tom\b|Evan|Aaron|Arthur|Gordon|Lee\b|Oliver|Reed|Rishi|Ralph|Nathan|Rocko|Eddy|Grandpa|Male|Microsoft (Guy|Ryan|Prabhat|William|Davis|Andrew|Brian|Christopher|Eric|David|Mark|Ravi))/i;
export function voiceGender(v: SpeechSynthesisVoice): "female" | "male" | "other" {
  return FEMALE.test(v.name) ? "female" : MALE.test(v.name) ? "male" : "other";
}

const quality = (v: SpeechSynthesisVoice) =>
  (/(premium|enhanced|natural|neural)/i.test(v.name) ? 40 : 0) +
  (/(Ava|Samantha|Allison|Evan|Zoe|Serena|Daniel|Karen|Moira|Veena|Google UK English|Google US English|Microsoft (Aria|Jenny|Guy|Neerja|Prabhat))/i.test(v.name) ? 20 : 0) +
  (v.localService ? 0 : 5) +
  (v.lang === navigator.language ? 3 : 0);

/** English-speaking (or the user's language) voices, best first. */
export function usableVoices(): SpeechSynthesisVoice[] {
  const voices = window.speechSynthesis.getVoices();
  const lang = (navigator.language || "en-US").slice(0, 2);
  const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang) || v.lang.toLowerCase().startsWith("en"));
  return [...(mine.length ? mine : voices)].sort((a, b) => quality(b) - quality(a));
}

/** Voices load late (Safari, Chrome): wait for them, up to 2 s, so the first sentence already has the right voice. */
function voicesReady(): Promise<void> {
  if (window.speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", done);
      resolve();
    };
    window.speechSynthesis.addEventListener("voiceschanged", done);
    setTimeout(done, 2000);
  });
}

/** The chosen voice if it's here, else the most natural one (a warm female voice first, like most assistants). */
function pickVoice(name?: string): SpeechSynthesisVoice | null {
  const list = usableVoices();
  return list.find((v) => v.name === name) ?? list.find((v) => voiceGender(v) === "female") ?? list[0] ?? null;
}

/** Words that appear one by one with a soft fade (for live captions). */
export function FadeWords({ text, className }: { text: string; className?: string }) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <span className={className}>
      {words.map((w, i) => (
        <span key={`${i}-${w}`} className="word-in inline-block" style={{ animationDelay: `${Math.min(i, 30) * 18}ms` }}>
          {w}&nbsp;
        </span>
      ))}
    </span>
  );
}

export function VoiceMode({
  context,
  sessionId,
  onDone,
}: {
  context: string;
  sessionId: string;
  /** voice mode ended: everything said (to put in the chat), and the agreed plan if there is one */
  onDone: (turns: Turn[], plan?: string) => void;
}) {
  const [prefs, setPrefs] = useState<VoicePrefs>(() => (typeof window === "undefined" ? { persona: "warm", rate: 0.97 } : loadPrefs()));
  const prefsRef = useRef(prefs);
  const [panel, setPanel] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [phase, setPhase] = useState<Phase>("starting");
  const [heard, setHeard] = useState(""); // what you're saying right now
  const [said, setSaid] = useState(""); // what it last said
  const [err, setErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0); // 0..1 mic level, drives the glow

  const turns = useRef<Turn[]>([]);
  const rec = useRef<Rec | null>(null);
  const phaseRef = useRef<Phase>("starting");
  const mutedRef = useRef(false);
  const utter = useRef("");
  const silence = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const audio = useRef<{ ctx: AudioContext; stream: MediaStream; raf: number } | null>(null);
  // listen() hands your finished sentence to respond(); a ref breaks the circle between the two
  const respondRef = useRef<() => Promise<void>>(async () => {});

  const go = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  /* ---------- speaking ---------- */
  // speak sentence by sentence with a short breath in between, so it's easy to follow (one long utterance runs on)
  const speak = useCallback(
    async (text: string) => {
      const synth = window.speechSynthesis;
      synth.cancel();
      go("speaking");
      setSaid(text);
      const clean = text.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim();
      const parts = clean.match(/[^.!?;:]+[.!?;:]+["')\]]*|[^.!?;:]+$/g)?.map((p) => p.trim()).filter(Boolean) ?? [clean];
      const v = pickVoice(prefsRef.current.voice);
      if (v && !prefsRef.current.voice) prefsRef.current = { ...prefsRef.current, voice: v.name };
      for (let i = 0; i < parts.length; i++) {
        if (!alive.current || phaseRef.current !== "speaking") return;
        await new Promise<void>((resolve) => {
          const u = new SpeechSynthesisUtterance(parts[i]);
          if (v) {
            u.voice = v;
            u.lang = v.lang; // Safari otherwise falls back to the default voice for the page language
          }
          u.rate = prefsRef.current.rate;
          u.pitch = 1;
          u.onend = () => resolve();
          u.onerror = () => resolve();
          synth.speak(u);
        });
        // a breath between sentences (longer after a question)
        if (i < parts.length - 1) await new Promise((r) => setTimeout(r, /[?]$/.test(parts[i]) ? 380 : 260));
      }
    },
    [go],
  );

  /* ---------- listening ---------- */
  const listen = useCallback(() => {
    if (!alive.current || mutedRef.current) return;
    const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) {
      setErr("This browser can't listen. Try Chrome or Safari.");
      go("error");
      return;
    }
    rec.current?.abort();
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true;
    utter.current = "";
    setHeard("");
    r.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) utter.current += `${t} `;
        else interim += t;
      }
      setHeard(`${utter.current}${interim}`.trim());
      // a short pause after you finish a sentence = your turn is over
      if (silence.current) clearTimeout(silence.current);
      silence.current = setTimeout(() => {
        if (utter.current.trim() && phaseRef.current === "listening") void respondRef.current();
      }, interim ? 1600 : 950);
    };
    r.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setErr("Allow the microphone for this site to use voice mode.");
        go("error");
      }
    };
    // browsers end recognition after a while: keep listening while it's our turn to listen
    r.onend = () => {
      if (alive.current && phaseRef.current === "listening" && !mutedRef.current) {
        try {
          r.start();
        } catch {
          /* already started */
        }
      }
    };
    rec.current = r;
    go("listening");
    try {
      r.start();
    } catch {
      /* already started */
    }
  }, [go]);

  const respond = useCallback(async () => {
    const text = utter.current.trim();
    if (!text) return;
    if (silence.current) clearTimeout(silence.current);
    rec.current?.abort();
    turns.current.push({ role: "user", text });
    go("thinking");
    try {
      const r = await api<{ say: string; stage: string; plan?: string }>("/api/ai/voice", { turns: turns.current, context, sessionId, persona: prefsRef.current.persona });
      if (!alive.current) return;
      turns.current.push({ role: "assistant", text: r.say });
      await speak(r.say);
      if (!alive.current) return;
      if (r.stage === "go" && r.plan) return onDone([...turns.current], r.plan);
      if (r.stage === "end") return onDone([...turns.current]);
      listen();
    } catch (e) {
      setErr((e as Error).message);
      go("error");
    }
  }, [context, sessionId, go, speak, listen, onDone]);
  useEffect(() => {
    respondRef.current = respond;
  }, [respond]);

  /* ---------- mic level for the glow ---------- */
  useEffect(() => {
    let cancelled = false;
    void navigator.mediaDevices
      ?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += ((v - 128) / 128) ** 2;
          setLevel((l) => l * 0.7 + Math.min(1, Math.sqrt(sum / buf.length) * 6) * 0.3);
          if (audio.current) audio.current.raf = requestAnimationFrame(tick);
        };
        audio.current = { ctx, stream, raf: requestAnimationFrame(tick) };
      })
      .catch(() => {
        /* the glow just breathes on its own */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- start: a short greeting, then listen ---------- */
  useEffect(() => {
    alive.current = true;
    // voices load lazily in some browsers
    window.speechSynthesis.getVoices();
    const t = setTimeout(() => {
      void (async () => {
        await voicesReady();
        if (!alive.current) return;
        await speak("Hi, I'm listening. What would you like to do?");
        if (alive.current) listen();
      })();
    }, 150);
    return () => {
      alive.current = false;
      clearTimeout(t);
      if (silence.current) clearTimeout(silence.current);
      rec.current?.abort();
      window.speechSynthesis.cancel();
      if (audio.current) {
        cancelAnimationFrame(audio.current.raf);
        audio.current.stream.getTracks().forEach((x) => x.stop());
        void audio.current.ctx.close();
        audio.current = null;
      }
    };
  }, [speak, listen]);

  // voices arrive late in some browsers
  useEffect(() => {
    const load = () => setVoices(usableVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  const update = (p: Partial<VoicePrefs>) => {
    const next = { ...prefsRef.current, ...p };
    prefsRef.current = next;
    setPrefs(next);
    savePrefs(next);
  };
  const preview = (v: SpeechSynthesisVoice) => {
    update({ voice: v.name });
    if (phaseRef.current === "thinking") return;
    rec.current?.abort();
    void speak(`Hi, I'm ${v.name.split(/[ (]/)[0]}. This is how I'll sound.`).then(() => alive.current && !mutedRef.current && listen());
  };

  const toggleMute = () => {
    const m = !mutedRef.current;
    mutedRef.current = m;
    setMuted(m);
    if (m) {
      rec.current?.abort();
      if (phaseRef.current === "listening") go("paused");
    } else if (phaseRef.current === "paused") listen();
  };

  // tap while it speaks: stop talking and listen
  const interrupt = () => {
    if (phaseRef.current !== "speaking") return;
    window.speechSynthesis.cancel();
    listen();
  };

  const status =
    phase === "starting" ? "Starting…" : phase === "listening" ? "Listening…" : phase === "thinking" ? "Thinking…" : phase === "speaking" ? "Speaking…" : phase === "paused" ? "Mic off" : "Voice mode stopped";
  const glow = phase === "speaking" ? 0.9 : phase === "listening" ? 0.35 + level * 0.65 : phase === "thinking" ? 0.5 : 0.2;

  return (
    <div className="relative">
      {/* the glow, rising from behind the bar */}
      {/* faded at every edge (mask), so it reads as light, never as a box */}
      <div aria-hidden className="voice-glow-wrap pointer-events-none absolute inset-x-[-12%] bottom-6 h-[300px] overflow-hidden">
        <div
          className={cx("voice-glow absolute inset-x-0 bottom-[-120px] h-[320px] rounded-[50%] blur-3xl transition-[opacity,transform,background] duration-500", phase === "thinking" && "voice-glow-think")}
          style={{
            opacity: glow,
            transform: `scale(${0.92 + (phase === "listening" ? level * 0.18 : 0)}, ${0.85 + glow * 0.3})`,
            background:
              phase === "listening"
                ? "radial-gradient(closest-side, hsl(var(--h) 70% 55% / .55), hsl(var(--h) 60% 40% / .25) 55%, transparent)"
                : "radial-gradient(closest-side, hsl(18 75% 58% / .6), hsl(12 55% 38% / .28) 55%, transparent)",
          }}
        />
        <div className="voice-grain absolute inset-0" />
      </div>

      {/* captions */}
      <div className="relative mb-3 min-h-[3.5rem] px-2 text-center">
        {phase === "speaking" || (phase === "thinking" && said) ? (
          <FadeWords key={said} text={said} className="text-[15px] leading-relaxed text-zinc-200" />
        ) : heard ? (
          <FadeWords text={heard} className="text-[15px] leading-relaxed text-white" />
        ) : null}
        {err && <p className="mt-1 text-[13px] text-[var(--critical-text)]">{err}</p>}
      </div>

      <div className="relative flex items-center gap-2 rounded-2xl border border-white/[0.09] bg-pop/90 px-3 py-2.5 shadow-lg shadow-black/20 backdrop-blur" onClick={interrupt}>
        <span className="flex size-8 items-center justify-center">
          {phase === "thinking" || phase === "starting" ? (
            <Loader2 className="size-4 animate-spin text-zinc-400" />
          ) : (
            <span className="flex h-4 items-end gap-[3px]" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={cx("w-[3px] rounded-full", phase === "speaking" ? "voice-bar bg-[hsl(18_75%_62%)]" : "bg-[var(--accent)]")}
                  style={phase === "speaking" ? { animationDelay: `${i * 120}ms` } : { height: `${4 + Math.round(level * 12 * (1 - Math.abs(i - 1.5) / 3))}px` }}
                />
              ))}
            </span>
          )}
        </span>
        <span className="flex-1 text-[14.5px] text-zinc-400">
          {status}
          {phase === "speaking" && <span className="ml-2 text-[12px] text-zinc-600">tap to interrupt</span>}
        </span>
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPanel((x) => !x);
            }}
            className={cx("flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-zinc-300 transition-colors hover:bg-white/[0.06]", panel && "bg-white/[0.06] text-white")}
            title="Voice and personality"
          >
            <SlidersHorizontal className="size-3.5" /> {(voices.find((v) => v.name === prefs.voice) ?? pickVoice(prefs.voice))?.name.split(/[ (]/)[0] ?? "Voice"}
          </button>
          {panel && (
            <div onClick={(e) => e.stopPropagation()} className="absolute right-0 bottom-11 z-40 w-80 rounded-xl border border-white/[0.09] bg-pop p-3 shadow-2xl shadow-black/50">
              <p className="text-[11.5px] font-medium tracking-wide text-zinc-500 uppercase">Personality</p>
              <div className="mt-2 grid grid-cols-3 gap-1">
                {PERSONAS.map((p) => (
                  <button key={p.id} onClick={() => update({ persona: p.id })} className={cx("rounded-lg border px-2 py-1.5 text-left", prefs.persona === p.id ? "border-white/25 bg-white/[0.08]" : "border-white/[0.06] hover:bg-white/[0.04]")}>
                    <span className="block text-[12.5px] text-white">{p.label}</span>
                    <span className="block text-[10.5px] leading-tight text-zinc-500">{p.hint}</span>
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[11.5px] font-medium tracking-wide text-zinc-500 uppercase">Speed</p>
              <div className="mt-2 flex gap-1">
                {(
                  [
                    [0.88, "Relaxed"],
                    [0.97, "Natural"],
                    [1.1, "Quick"],
                  ] as const
                ).map(([r, l]) => (
                  <button key={l} onClick={() => update({ rate: r })} className={cx("flex-1 rounded-lg border px-2 py-1 text-[12px]", Math.abs(prefs.rate - r) < 0.01 ? "border-white/25 bg-white/[0.08] text-white" : "border-white/[0.06] text-zinc-400 hover:bg-white/[0.04]")}>
                    {l}
                  </button>
                ))}
              </div>
              <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                {(["female", "male", "other"] as const).map((g) => {
                  const list = voices.filter((v) => voiceGender(v) === g).slice(0, 14);
                  if (!list.length) return null;
                  return (
                    <div key={g}>
                      <p className="text-[11.5px] font-medium tracking-wide text-zinc-500 uppercase">{g === "female" ? "Female voices" : g === "male" ? "Male voices" : "Other voices"}</p>
                      {list.map((v) => {
                        const on = (prefs.voice ?? pickVoice()?.name) === v.name;
                        return (
                          <button key={v.name} onClick={() => preview(v)} className={cx("mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]", on ? "bg-white/[0.08] text-white" : "text-zinc-300 hover:bg-white/[0.04]")}>
                            {on ? <Check className="size-3.5 text-[var(--good)]" /> : <Play className="size-3 text-zinc-500" />}
                            <span className="min-w-0 flex-1 truncate">{v.name}</span>
                            <span className="text-[10.5px] text-zinc-500">{v.lang}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {!voices.length && <p className="text-[12px] text-zinc-500">Loading voices…</p>}
              </div>
              <p className="mt-2 text-[10.5px] leading-snug text-zinc-600">Voices come from your device. On a Mac, more natural ones (Ava, Zoe, Evan…) can be added in System Settings → Accessibility → Spoken Content.</p>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleMute();
          }}
          className={cx("grid size-9 place-items-center rounded-lg transition-colors", muted ? "bg-[var(--critical)]/20 text-[var(--critical-text)]" : "text-zinc-300 hover:bg-white/[0.06]")}
          aria-label={muted ? "Turn the mic on" : "Turn the mic off"}
          title={muted ? "Turn the mic on" : "Turn the mic off"}
        >
          {muted ? <MicOff className="size-[17px]" /> : <Mic className="size-[17px]" />}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDone([...turns.current]);
          }}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-[#2b5dd6]/20 px-3 text-[13px] font-medium text-[#8fb0ff] hover:bg-[#2b5dd6]/30"
        >
          <AudioLines className="size-4" /> End
        </button>
      </div>
    </div>
  );
}
