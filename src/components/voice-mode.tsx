"use client";

// Voice mode: talk with the Assistant like a call. It listens (the browser's speech recognition), thinks with a
// fast advisor model that asks one question at a time, speaks back (speech synthesis), and once you agree to the
// plan it hands the full instruction to the Assistant in the chat. A soft glow breathes with your voice while it
// listens and warms up while it speaks.
import { AudioLines, Check, GitBranch, Mic, MicOff, Play, Plug, Server, SlidersHorizontal, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Item } from "@/lib/assistant-items";
import { api } from "@/lib/client";
import { appendVoice, decide, useAssistant } from "./assistant-store";
import { UnsplashLayer, useTheme } from "./theme";
import { VoiceWaves } from "./voice-waves";
import { cx } from "./ui";

type Phase = "starting" | "listening" | "thinking" | "working" | "speaking" | "paused" | "error";
export interface VoiceOption {
  label: string;
  detail?: string;
  say: string;
  kind?: "attach" | "project" | "repo" | "service";
}

const YES = /\b(yes|yeah|yep|yup|sure|go ahead|do it|ok(ay)?|approve|send it|go for it|please do)\b/i;
const NO = /\b(no|nope|don'?t|cancel|skip|stop|leave it|not now)\b/i;

const GREETED = "hosting.voice.last-greeting";
const lastGreeting = () => {
  try {
    return localStorage.getItem(GREETED) ?? "";
  } catch {
    return "";
  }
};
const rememberGreeting = (g: string) => {
  try {
    localStorage.setItem(GREETED, g);
  } catch {
    /* blocked */
  }
};

const localTime = () => new Date().toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });

/** If the greeting can't be fetched: still never the same line twice in a row. */
const FALLBACK_GREETINGS = ["Hey Sam! How's it going? What can I do for you today?", "Hi Sam! Great to hear from you. What are we building?", "Hey Sam! Ready when you are. What's up?", "Sam! Good to see you. What can I help with?"];

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

export type Persona = "upbeat" | "chill" | "warm" | "professional" | "direct";
export const PERSONAS: { id: Persona; label: string; hint: string }[] = [
  { id: "upbeat", label: "Upbeat", hint: "positive, energetic" },
  { id: "chill", label: "Chill", hint: "easy-going mate" },
  { id: "warm", label: "Warm", hint: "kind, encouraging" },
  { id: "professional", label: "Professional", hint: "calm consultant" },
  { id: "direct", label: "Direct", hint: "fewest words" },
];
interface VoicePrefs {
  voice?: string;
  persona: Persona;
  /** the persona was chosen by the user (not a default) */
  pickedPersona?: boolean;
  rate: number;
  /** don't listen while it speaks: background noise (or you) can't interrupt it; tapping still does */
  holdMic?: boolean;
}
const PREFS = "hosting.voice";
function loadPrefs(): VoicePrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<VoicePrefs>;
    return { voice: p.voice, // the old defaults (warm, chill) move to Upbeat; a persona picked on purpose since stays
    persona: PERSONAS.some((x) => x.id === p.persona) && p.persona !== "warm" && !(p.persona === "chill" && !p.pickedPersona) ? p.persona! : "upbeat",
    pickedPersona: p.pickedPersona, rate: typeof p.rate === "number" && p.rate !== 1.03 && p.rate !== 0.97 ? p.rate : 1.02, holdMic: p.holdMic === true };
  } catch {
    return { persona: "upbeat", rate: 1.02 };
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
  (/(premium|enhanced|natural|neural|siri)/i.test(v.name) ? 60 : 0) +
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

/** Saying one of these while it talks stops it. */
const STOP_WORDS = /\b(stop|wait|hold on|pause|enough|quiet|shut up|cancel|be quiet)\b/;

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
  onTask,
  onAttach,
}: {
  context: string;
  sessionId: string;
  /** voice mode ended: what was said since the last save (to put in the chat) */
  onDone: (turns: Turn[]) => void;
  /** hand a task to the Assistant in this chat (voice mode stays open and reads the result back) */
  onTask: (plan: string) => void;
  /** open the file picker (to upload a project zip) */
  onAttach?: () => void;
}) {
  const [prefs, setPrefs] = useState<VoicePrefs>(() => (typeof window === "undefined" ? { persona: "upbeat", rate: 1.02 } : loadPrefs()));
  const prefsRef = useRef(prefs);
  const [panel, setPanel] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [phase, setPhase] = useState<Phase>("starting");
  const [heard, setHeard] = useState(""); // what you're saying right now
  const [said, setSaid] = useState(""); // what it last said
  const [parts, setParts] = useState<string[]>([]); // that reply, sentence by sentence
  const [at, setAt] = useState(-1); // the sentence being spoken
  const [lastYou, setLastYou] = useState(""); // your last sentence, shown above its reply
  const [options, setOptions] = useState<VoiceOption[]>([]); // choices it offered: tap one or just say it
  const { photo } = useTheme(); // the same Unsplash cover as the rest of the app, blurred behind the call
  const optionsRef = useRef<VoiceOption[]>([]);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const pickRef = useRef<(o: VoiceOption) => void>(() => {});
  // the fleet summary refreshes every 30 s: read it from a ref so voice mode never restarts because of it
  const ctx = useRef({ context, sessionId });
  useEffect(() => {
    ctx.current = { context, sessionId };
  }, [context, sessionId]);
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
  // words you said while interrupting it, carried into the next turn
  const carry = useRef("");
  // turns already saved into the chat (so End only adds the rest)
  const saved = useRef(0);
  // the chat this call belongs to, to follow a task the Assistant runs
  const { docs } = useAssistant();
  const docRef = useRef(docs[sessionId]);
  useEffect(() => {
    docRef.current = docs[sessionId];
  }, [docs, sessionId]);
  const runFrom = useRef(0); // where the running task's items start
  const approval = useRef<{ id: string; label: string } | null>(null);

  const go = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  /* ---------- speaking ---------- */
  /**
   * While it speaks, keep listening: if you start talking it stops and hands over what you said so far ("stop",
   * "wait"… stop it too). Its own voice coming back through the mic doesn't count: words it is saying are ignored.
   */
  const watchForYou = useCallback((own: string, onYou: (said: string) => void) => {
    const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor || mutedRef.current) return null;
    const ownWords = new Set(own.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean));
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true;
    let done = false;
    r.onresult = (ev) => {
      if (done) return;
      let t = "";
      for (let i = 0; i < ev.results.length; i++) t += `${ev.results[i][0].transcript} `;
      const heardNow = t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
      const stop = t.toLowerCase().match(STOP_WORDS);
      const yours = heardNow.filter((w) => !ownWords.has(w));
      // a stop word, or at least two words of yours that make up most of what was heard
      if ((stop && !ownWords.has(stop[0])) || (yours.length >= 2 && yours.length / heardNow.length >= 0.5)) {
        done = true;
        onYou(stop && yours.length < 3 ? "" : t.trim());
      }
    };
    r.onerror = () => {};
    r.onend = () => {
      if (!done && phaseRef.current === "speaking")
        try {
          r.start();
        } catch {
          /* already running */
        }
    };
    try {
      r.start();
    } catch {
      return null;
    }
    return r;
  }, []);

  // speak sentence by sentence with a short breath in between, so it's easy to follow (one long utterance runs on).
  // Resolves true when it said everything, false when you stopped or interrupted it.
  const speak = useCallback(
    async (text: string): Promise<boolean> => {
      const synth = window.speechSynthesis;
      synth.cancel();
      go("speaking");
      setSaid(text);
      const clean = text.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim();
      const list = clean.match(/[^.!?;:]+[.!?;:]+["')\]]*|[^.!?;:]+$/g)?.map((p) => p.trim()).filter(Boolean) ?? [clean];
      setParts(list);
      setAt(0);
      const v = pickVoice(prefsRef.current.voice);
      if (v && !prefsRef.current.voice) prefsRef.current = { ...prefsRef.current, voice: v.name };
      let stopped = false;
      const watch = prefsRef.current.holdMic
        ? null
        : watchForYou(clean, (yours) => {
            stopped = true;
            carry.current = yours; // what you started saying; listening picks it up from there
            synth.cancel();
          });
      try {
        for (let i = 0; i < list.length; i++) {
          if (stopped || !alive.current || phaseRef.current !== "speaking") return false;
          setAt(i);
          await new Promise<void>((resolve) => {
            const u = new SpeechSynthesisUtterance(list[i]);
            if (v) {
              u.voice = v;
              u.lang = v.lang; // Safari otherwise falls back to the default voice for the page language
            }
            u.rate = prefsRef.current.rate;
            // a touch brighter for the upbeat voice (browser voices sound flat at the default pitch)
            u.pitch = prefsRef.current.persona === "upbeat" ? 1.12 : prefsRef.current.persona === "professional" ? 0.98 : 1.04;
            u.onend = () => resolve();
            u.onerror = () => resolve();
            synth.speak(u);
          });
          // a breath between sentences (longer after a question)
          if (i < list.length - 1 && !stopped) await new Promise((r) => setTimeout(r, /[?]$/.test(list[i]) ? 380 : 260));
        }
        if (!stopped) setAt(list.length);
        return !stopped && phaseRef.current === "speaking";
      } finally {
        watch?.abort();
      }
    },
    [go, watchForYou],
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
    // if you interrupted it, start from what you'd already said
    const seed = carry.current.trim();
    carry.current = "";
    utter.current = seed ? `${seed} ` : "";
    setHeard(seed);
    r.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) utter.current += `${t} `;
        else interim += t;
      }
      setHeard(`${utter.current}${interim}`.trim());
      setLevel((l) => Math.min(1, l + 0.35));
      setTimeout(() => setLevel((l) => l * 0.5), 260);
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

  /** After a task was handed over: wait for the Assistant, ask for approvals out loud, then read out the result. */
  const follow = useCallback(async () => {
    go("working");
    const from = runFrom.current;
    const t0 = Date.now();
    let started = false;
    while (alive.current && Date.now() - t0 < 6 * 60_000) {
      await new Promise((r) => setTimeout(r, 600));
      const d = docRef.current;
      if (!d) continue;
      const fresh = d.items.slice(from);
      if (d.busy) started = true;
      const wait = fresh.find((i): i is Extract<Item, { kind: "approval" }> => i.kind === "approval" && i.decision === undefined);
      if (wait && !d.busy) {
        approval.current = { id: wait.id, label: wait.label };
        const ask = `It needs your OK first: ${wait.label.replace(/\s+/g, " ").slice(0, 140)}. Should I go ahead?`;
        turns.current.push({ role: "assistant", text: ask });
        await speak(ask);
        if (alive.current) listen();
        return;
      }
      if ((started || Date.now() - t0 > 8000) && !d.busy) {
        const texts = fresh.filter((i): i is Extract<Item, { kind: "text" }> => i.kind === "text").map((i) => i.text);
        const result = texts[texts.length - 1] ?? "";
        let say = result ? "" : "Done.";
        if (result) {
          go("thinking");
          say = await api<{ say: string }>("/api/ai/voice", { summarize: result, turns: turns.current, sessionId: ctx.current.sessionId, persona: prefsRef.current.persona })
            .then((r) => r.say)
            .catch(() => "It's done. The details are in the chat.");
        }
        if (!alive.current) return;
        turns.current.push({ role: "assistant", text: say });
        await speak(say);
        if (alive.current) listen();
        return;
      }
    }
    if (alive.current) {
      await speak("That's taking a while. It keeps going in the chat; I'm still here.");
      if (alive.current) listen();
    }
  }, [go, speak, listen]);

  /** Save what was said so far into the chat, then hand the task over and follow it. */
  const runTask = useCallback(
    async (plan: string) => {
      const fresh = turns.current.slice(saved.current);
      saved.current = turns.current.length;
      go("working");
      await appendVoice(ctx.current.sessionId, fresh).catch(() => {});
      runFrom.current = docRef.current?.items.length ?? 0;
      onTask(plan);
      await follow();
    },
    [go, onTask, follow],
  );

  const respond = useCallback(async () => {
    const text = utter.current.trim();
    if (!text) return;
    if (silence.current) clearTimeout(silence.current);
    rec.current?.abort();
    turns.current.push({ role: "user", text });
    setLastYou(text);
    setParts([]);
    setOptions([]);
    // answering an approval the Assistant is waiting for
    const pending = approval.current;
    if (pending) {
      const ok = YES.test(text) && !NO.test(text) ? true : NO.test(text) ? false : null;
      if (ok === null) {
        const again = "Sorry, was that a yes or a no?";
        turns.current.push({ role: "assistant", text: again });
        await speak(again);
        if (alive.current) listen();
        return;
      }
      approval.current = null;
      decide(ctx.current.sessionId, pending.id, ok);
      const said = ok ? "Okay, going ahead." : "Okay, skipping that.";
      turns.current.push({ role: "assistant", text: said });
      await speak(said);
      if (alive.current) await follow();
      return;
    }
    go("thinking");
    try {
      const r = await api<{ say: string; stage: string; plan?: string; options?: VoiceOption[] }>("/api/ai/voice", {
        turns: turns.current,
        context: ctx.current.context,
        sessionId: ctx.current.sessionId,
        persona: prefsRef.current.persona,
        localTime: localTime(),
      });
      if (!alive.current) return;
      turns.current.push({ role: "assistant", text: r.say });
      const finished = await speak(r.say);
      if (!alive.current) return;
      // you cut in (talking, "stop" or a tap): note it, don't carry on with a plan it was announcing, listen to you
      if (!finished) {
        const last = turns.current[turns.current.length - 1];
        if (last?.role === "assistant") last.text = `${last.text} (the user interrupted before I finished)`;
        return listen();
      }
      if (r.stage === "go" && r.plan) return void runTask(r.plan);
      setOptions(r.options ?? []);
      if (r.stage === "end") return onDone(turns.current.slice(saved.current));
      listen();
    } catch (e) {
      setErr((e as Error).message);
      go("error");
    }
  }, [go, speak, listen, onDone, runTask, follow]);
  useEffect(() => {
    respondRef.current = respond;
  }, [respond]);

  /* ---------- mic level for the glow ---------- */
  useEffect(() => {
    let cancelled = false;
    // Safari asks for the mic separately for this stream and for speech recognition: skip it there, so there's
    // only one prompt (the glow then pulses with the words it hears instead of the sound level)
    if (/^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent)) return;
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
        const [, hello] = await Promise.all([
          voicesReady(),
          api<{ say: string }>("/api/ai/voice", { greet: true, context: ctx.current.context, sessionId: ctx.current.sessionId, persona: prefsRef.current.persona, localTime: localTime(), avoid: lastGreeting() })
            .then((r) => {
              rememberGreeting(r.say);
              return r.say;
            })
            .catch(() => FALLBACK_GREETINGS[Math.floor(Math.random() * FALLBACK_GREETINGS.length)]),
        ]);
        if (!alive.current) return;
        turns.current.push({ role: "assistant", text: hello });
        await speak(hello);
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

  // tapping a choice is the same as saying it; "Upload a project" opens the file picker too
  const pick = (o: VoiceOption) => {
    window.speechSynthesis.cancel();
    if (silence.current) clearTimeout(silence.current);
    rec.current?.abort();
    if (o.kind === "attach") onAttach?.();
    utter.current = o.kind === "attach" ? "I'm uploading the project as a zip file now. Deploy it when it's uploaded." : o.say;
    go("listening"); // respond() only takes a turn from the listening state
    void respondRef.current();
  };

  useEffect(() => {
    pickRef.current = pick;
  });

  // Esc ends voice mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone(turns.current.slice(saved.current));
      // 1-6 pick one of the offered choices
      const n = Number(e.key);
      if (n >= 1 && n <= optionsRef.current.length && !(e.target instanceof HTMLInputElement)) pickRef.current(optionsRef.current[n - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

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
    phase === "starting" ? "Starting…" : phase === "listening" ? "Listening…" : phase === "thinking" ? "Thinking…" : phase === "working" ? "Working on it…" : phase === "speaking" ? "Speaking…" : phase === "paused" ? "Mic off" : "Voice mode stopped";
  const glow = phase === "speaking" ? 0.9 : phase === "listening" ? 0.35 + level * 0.65 : phase === "thinking" ? 0.5 : 0.2;

  return createPortal(
    <div className="voice-in fixed inset-0 z-[70] flex flex-col" role="dialog" aria-modal="true" aria-label="Voice mode">
      {/* the app behind, frosted, with today's Unsplash cover softly blurred into it */}
      <div aria-hidden className="absolute inset-0 bg-[var(--bg)]/60 backdrop-blur-2xl backdrop-saturate-150" />
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-[-10%] opacity-40 blur-[60px] saturate-150">
          <UnsplashLayer photo={photo} className="h-full w-full" />
        </div>
      </div>
      {/* the glow, rising from the bottom; faded at every edge (mask), so it reads as light, never as a box */}
      <div aria-hidden className="voice-glow-wrap pointer-events-none absolute inset-x-0 bottom-0 h-[460px] overflow-hidden">
        <div
          className={cx("voice-glow absolute inset-x-[8%] bottom-[-140px] h-[380px] rounded-[50%] blur-3xl transition-[opacity,transform,background] duration-500", phase === "thinking" && "voice-glow-think")}
          style={{
            opacity: glow,
            transform: `scale(${0.92 + (phase === "listening" ? level * 0.18 : 0)}, ${0.85 + glow * 0.3})`,
            // the photo's hue: cooler while it listens, a warmer neighbour of it while it speaks
            background:
              phase === "listening"
                ? "radial-gradient(closest-side, hsl(var(--h) 70% 55% / .55), hsl(var(--h) 60% 40% / .25) 55%, transparent)"
                : "radial-gradient(closest-side, hsl(calc(var(--h) + 25) 72% 60% / .6), hsl(calc(var(--h) + 10) 55% 40% / .28) 55%, transparent)",
          }}
        />
        <div className="voice-grain absolute inset-0" />
      </div>

      {/* captions, in the middle of the screen */}
      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-8 py-16">
        <div className="w-full max-w-3xl text-center">
          <div className="mb-8 flex justify-center">
            <VoiceWaves phase={phase === "working" ? "thinking" : phase} level={level} />
          </div>
          {lastYou && (phase === "thinking" || phase === "speaking") && (
            <p key={lastYou} className="word-in mb-6 text-[15px] leading-relaxed text-zinc-500">
              {lastYou}
            </p>
          )}
          {phase === "speaking" || (phase === "thinking" && parts.length) ? (
            <p className="text-[26px] leading-[1.45] font-medium tracking-[-0.01em]">
              {parts.map((p, i) => (
                <span key={`${said}-${i}`} className={cx("word-in transition-colors duration-500", i < at ? "text-zinc-300" : i === at ? "text-white" : "text-zinc-600")} style={{ animationDelay: `${i * 60}ms` }}>
                  {p}{" "}
                </span>
              ))}
            </p>
          ) : phase === "thinking" ? null : heard ? (
            <FadeWords text={heard} className="text-[26px] leading-[1.45] font-medium tracking-[-0.01em] text-white" />
          ) : (
            <p className="text-[22px] text-zinc-500">{phase === "listening" ? "Go ahead, I'm listening." : phase === "paused" ? "Mic is off." : ""}</p>
          )}
          {options.length > 0 && phase !== "thinking" && phase !== "working" && (
            <div className="mx-auto mt-10 grid max-w-3xl grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5 text-left">
              {options.map((o, i) => {
                const Icon = o.kind === "attach" ? Upload : o.kind === "repo" || o.label.includes("/") ? GitBranch : o.kind === "service" ? Plug : Server;
                return (
                  <button
                    key={`${o.label}-${i}`}
                    onClick={() => pick(o)}
                    className="word-in group flex items-center gap-3 rounded-2xl border border-white/[0.1] bg-white/[0.045] px-3.5 py-3 backdrop-blur-md transition-[background-color,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-white/[0.22] hover:bg-white/[0.09]"
                    style={{ animationDelay: `${120 + i * 70}ms` }}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[hsl(var(--h)_60%_55%/.16)] text-[hsl(var(--h)_80%_78%)] ring-1 ring-[hsl(var(--h)_60%_60%/.25)]">
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-white">{o.label}</span>
                      <span className="block truncate text-[12px] text-zinc-400">{o.detail ?? (o.kind === "attach" ? "Pick a .zip from your computer" : o.kind === "repo" ? "GitHub" : "")}</span>
                    </span>
                    <span className="text-[11px] text-zinc-600 transition-colors group-hover:text-zinc-400">{i + 1}</span>
                  </button>
                );
              })}
            </div>
          )}
          {err && <p className="mt-4 text-[14px] text-[var(--critical-text)]">{err}</p>}
          {phase === "speaking" && (
            <p className="mt-6 text-[12.5px] text-zinc-500">{prefs.holdMic ? "Your mic is muted while it speaks · tap the bar to cut in" : "Just start talking to interrupt"}</p>
          )}
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-[760px] px-4 pb-8">
      <div className="relative flex items-center gap-2 rounded-2xl border border-white/[0.09] bg-pop/90 px-3 py-2.5 shadow-lg shadow-black/20 backdrop-blur" onClick={interrupt}>
        <span className="flex size-8 items-center justify-center">
          {phase === "thinking" || phase === "starting" || phase === "working" ? (
            <VoiceWaves phase="thinking" mini width={30} height={20} />
          ) : (
            <span className="flex h-4 items-end gap-[3px]" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={cx("w-[3px] rounded-full", phase === "speaking" ? "voice-bar bg-[var(--accent-soft)]" : "bg-[var(--accent)]")}
                  style={phase === "speaking" ? { animationDelay: `${i * 120}ms` } : { height: `${4 + Math.round(level * 12 * (1 - Math.abs(i - 1.5) / 3))}px` }}
                />
              ))}
            </span>
          )}
        </span>
        <span className="flex-1 text-[14.5px] text-zinc-400">
          {status}
          {phase === "speaking" && <span className="ml-2 text-[12px] text-zinc-600">{prefs.holdMic ? "mic muted · tap to cut in" : "talk to interrupt"}</span>}
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
              <div className="mt-2 grid grid-cols-2 gap-1">
                {PERSONAS.map((p) => (
                  <button key={p.id} onClick={() => update({ persona: p.id, pickedPersona: true })} className={cx("rounded-lg border px-2 py-1.5 text-left", prefs.persona === p.id ? "border-white/25 bg-white/[0.08]" : "border-white/[0.06] hover:bg-white/[0.04]")}>
                    <span className="block text-[12.5px] text-white">{p.label}</span>
                    <span className="block text-[10.5px] leading-tight text-zinc-500">{p.hint}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => update({ holdMic: !prefs.holdMic })}
                role="switch"
                aria-checked={Boolean(prefs.holdMic)}
                className="mt-3 flex w-full items-start gap-3 rounded-lg border border-white/[0.06] px-2.5 py-2 text-left hover:bg-white/[0.04]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-white">Mute my mic while it speaks</span>
                  <span className="block text-[10.5px] leading-snug text-zinc-500">
                    {prefs.holdMic ? "Noise can't interrupt it. Tap the bar to cut in." : "Start talking any time and it stops to listen."}
                  </span>
                </span>
                <span className={cx("relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full transition-colors", prefs.holdMic ? "bg-[#2b5dd6]" : "bg-white/15")}>
                  <span className={cx("absolute top-[2px] size-[14px] rounded-full bg-white transition-all", prefs.holdMic ? "left-[16px]" : "left-[2px]")} />
                </span>
              </button>
              <p className="mt-3 text-[11.5px] font-medium tracking-wide text-zinc-500 uppercase">Speed</p>
              <div className="mt-2 flex gap-1">
                {(
                  [
                    [0.92, "Relaxed"],
                    [1.02, "Natural"],
                    [1.12, "Quick"],
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
            onDone(turns.current.slice(saved.current));
          }}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-[#2b5dd6]/20 px-3 text-[13px] font-medium text-[#8fb0ff] hover:bg-[#2b5dd6]/30"
        >
          <AudioLines className="size-4" /> End
        </button>
      </div>
      </div>
    </div>,
    document.body,
  );
}
