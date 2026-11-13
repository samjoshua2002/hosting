"use client";

import { ArrowUp, AtSign, AudioLines, Check, ChevronRight, ChevronUp, Cloud, Cpu, Database, FileText, FolderGit2, Globe, LayoutGrid, Laptop, Loader2, Mail, Mic, Paperclip, Plug, Plus, Server, Settings2, Slash, Sparkles, Square, Wrench, X, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Att } from "@/lib/assistant-items";
import { toggleConnector, useAssistant } from "./assistant-store";
import { FadeWords, VoiceMode, voiceSupported } from "./voice-mode";
import { connectorDef } from "@/lib/connector-catalog";
import { projectType, TYPE_LABEL, type ProjectType } from "@/lib/project-type";
import type { VmInfo, VmStatus } from "@/lib/types";
import { cx } from "./ui";

export interface Entity {
  name: string;
  kind: "project" | "database" | "machine" | "connector";
  type?: ProjectType;
  sub: string;
  /** connectors: ready to use, and the words to put in the message */
  connected?: boolean;
  say?: string;
  mail?: boolean;
  /** what the + menu switch turns off for this conversation (connector id or email address) */
  key?: string;
}

const TYPE_ICON: Record<ProjectType, LucideIcon> = { website: Globe, service: Server, worker: Cpu, database: Database, tool: Wrench };

type Pick = "project" | "database" | "machine" | "connector";
interface Command {
  cmd: string;
  hint: string;
  /** section in the / menu */
  group?: "Context" | "Model" | "Customize" | "Commands" | "Skills";
  /** label shown instead of /cmd (Claude Code style menu) */
  label?: string;
  pick?: Pick;
  /** text that replaces the command (n = picked name) */
  insert?: (n: string) => string;
  action?: "review" | "new" | "attach" | "mention" | "export" | "model";
  /** a dashboard page to open */
  href?: string;
}

/** The / menu's fixed sections (skills are added from the server). */
const BASE: Command[] = [
  { group: "Context", cmd: "attach", label: "Attach file…", hint: "", action: "attach" },
  { group: "Context", cmd: "mention", label: "Mention a project, database or machine…", hint: "@", action: "mention" },
  { group: "Context", cmd: "new", label: "New conversation", hint: "", action: "new" },
  { group: "Context", cmd: "export", label: "Export conversation", hint: "Markdown", action: "export" },
  { group: "Model", cmd: "model", label: "Switch model…", hint: "", action: "model" },
  { group: "Model", cmd: "review", label: "Review mode", hint: "", action: "review" },
  { group: "Customize", cmd: "mcp", label: "MCP servers", hint: "", href: "/settings?tab=connectors" },
  { group: "Context", cmd: "connectors", label: "Use a connector…", hint: "", pick: "connector" },
  { group: "Customize", cmd: "connector-settings", label: "Connector settings", hint: "", href: "/settings?tab=connectors" },
  { group: "Customize", cmd: "instructions", label: "Instructions", hint: "", href: "/settings?tab=instructions" },
  { group: "Customize", cmd: "memory", label: "Memory", hint: "", href: "/settings?tab=memory" },
  { group: "Customize", cmd: "skills", label: "Skills", hint: "", href: "/settings?tab=skills" },
  { group: "Customize", cmd: "autopilot", label: "Autopilot", hint: "", href: "/settings?tab=autopilot" },
  { group: "Customize", cmd: "tools", label: "Tools", hint: "", href: "/settings?tab=tools" },
];
const GROUP_ORDER = ["Context", "Model", "Customize", "Commands", "Skills"] as const;

export const COMMANDS: Command[] = [
  { cmd: "project", hint: "Tag a project to talk about", pick: "project", insert: (n) => `@${n} ` },
  { cmd: "pipeline", hint: "Explain a project's pipeline with a diagram", pick: "project", insert: (n) => `Explain the pipeline of @${n} with a diagram` },
  { cmd: "code", hint: "Change a project's code on GitHub", pick: "project", insert: (n) => `In @${n}'s GitHub repo, ` },
  { cmd: "deploy", hint: "Redeploy a project and check it", pick: "project", insert: (n) => `Redeploy @${n} and check that it's healthy` },
  { cmd: "logs", hint: "Read a project's logs", pick: "project", insert: (n) => `Show the latest logs of @${n} and tell me if anything is wrong` },
  { cmd: "remove", hint: "Remove a project everywhere", pick: "project", insert: (n) => `Remove @${n} from every machine it runs on` },
  { cmd: "database", hint: "Ask about a database's tables and data", pick: "database", insert: (n) => `@${n} ` },
  { cmd: "tables", hint: "List a database's tables with row counts", pick: "database", insert: (n) => `List the tables in @${n} with row counts` },
  { cmd: "connect", hint: "Connect a project to a database", pick: "project", insert: (n) => `Connect @${n} to ` },
  { cmd: "machine", hint: "Tag a machine", pick: "machine", insert: (n) => `@${n} ` },
  { cmd: "run", hint: "Run a command on a machine", pick: "machine", insert: (n) => `On @${n} run: ` },
  { cmd: "status", hint: "Check every machine and fix problems", insert: () => "Check every machine and fix anything that looks wrong" },
  { cmd: "schedule", hint: "Schedule a recurring task", insert: () => "Schedule a task that " },
  { cmd: "github", hint: "Repos, issues, pull requests, actions", insert: () => "On GitHub, " },
];

export function entitiesFrom(vms: VmInfo[], status: Record<string, VmStatus | undefined>): Entity[] {
  const projects = new Map<string, Entity>();
  for (const v of vms)
    for (const p of status[v.name]?.agent?.projects ?? []) {
      const t = projectType(p.manifest);
      const e = projects.get(p.manifest.name) ?? { name: p.manifest.name, kind: t === "database" ? ("database" as const) : ("project" as const), type: t, sub: "" };
      e.sub = e.sub ? `${e.sub}, ${v.name}` : `${TYPE_LABEL[t].one} · ${v.name}`;
      projects.set(p.manifest.name, e);
    }
  return [...projects.values(), ...vms.map((v) => ({ name: v.name, kind: "machine" as const, sub: status[v.name]?.ok ? "machine · online" : "machine · unreachable" }))];
}

/** What the Assistant should know about every @name in the message. */
export function contextFor(text: string, vms: VmInfo[], status: Record<string, VmStatus | undefined>): string {
  // @tags, plus plain mentions of any project or machine name ("is watch down?")
  const known = new Set([...vms.map((v) => v.name), ...vms.flatMap((v) => (status[v.name]?.agent?.projects ?? []).map((p) => p.manifest.name))]);
  const lower = text.toLowerCase();
  const bare = [...known].filter((n) => n.length >= 3 && new RegExp(`(^|[^a-z0-9-])${n.replace(/[-]/g, "\\-")}($|[^a-z0-9-])`).test(lower));
  const names = [...new Set([...[...text.matchAll(/(?<![\w.@])@([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]), ...bare])];
  const lines: string[] = [];
  for (const n of names) {
    const vm = vms.find((v) => v.name === n);
    if (vm) {
      const a = status[n]?.agent;
      lines.push(
        a
          ? `@${n}: machine, online, CPU ${Math.round(a.cpuPct)}%, memory ${(a.memAvailKb / 1048576).toFixed(1)}/${(a.memTotalKb / 1048576).toFixed(1)} GB free, disk ${((a.diskTotalKb - a.diskUsedKb) / 1048576).toFixed(1)} GB free, projects: ${a.projects.map((p) => p.manifest.name).join(", ") || "none"}`
          : `@${n}: machine, unreachable right now`,
      );
      continue;
    }
    const inst = vms.flatMap((v) => (status[v.name]?.agent?.projects ?? []).filter((p) => p.manifest.name === n).map((p) => ({ vm: v.name, p })));
    if (!inst.length) continue;
    const m = inst[0].p.manifest;
    const t = projectType(m);
    const url = inst.find((i) => i.p.url)?.p.url;
    const commit = inst.find((i) => i.p.commit)?.p.commit;
    lines.push(
      [
        `@${n}: ${TYPE_LABEL[t].one.toLowerCase()}${m.framework ? ` (${m.framework})` : ""}`,
        m.github ? `GitHub ${m.github.repo} @ ${m.branch}${m.github.private ? " (private)" : ""}, auto-deploy ${m.github.autoDeploy ? "on" : "off"}` : m.repo ? `repo ${m.repo} @ ${m.branch}` : "no git repo",
        `runs on ${inst.map((i) => `${i.vm} (${i.p.active})`).join(", ")}`,
        m.port ? `port ${m.port}${t === "database" ? " on 127.0.0.1 (private)" : ""}` : "no port",
        url ? `link ${url}` : "",
        commit ? `deployed ${commit.sha.slice(0, 7)} "${commit.message}"` : "",
        m.envKeys.length ? `env keys ${m.envKeys.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  return lines.length ? `\n\n[Context]\n${lines.join("\n")}` : "";
}

/** The browser's speech recognition (Chrome/Safari: webkitSpeechRecognition). */
interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type Menu = { kind: "commands"; items: Command[]; start: number; end: number } | { kind: "entities"; items: Entity[]; start: number; end: number; cmd?: Command };

export interface ModelChoice {
  id: string;
  label: string;
  sub: string;
  local: boolean;
}

/** Cloud models do the work (tools); local ones on your machines chat only. */
function ModelPicker({
  value,
  models,
  onChange,
  review,
  onReview,
  open,
  setOpen,
}: {
  value: string;
  models: ModelChoice[];
  onChange: (id: string) => void;
  review: "auto" | "manual";
  onReview: (r: "auto" | "manual") => void;
  open: boolean;
  setOpen: (o: boolean | ((o: boolean) => boolean)) => void;
}) {
  const cur = models.find((m) => m.id === value) ?? models[0];

  const group = (local: boolean) => models.filter((m) => m.local === local);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 max-w-[240px] items-center gap-1.5 rounded-md px-2 text-[12.5px] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
        title="Model and review mode"
      >
        <span className="truncate">{cur?.label ?? "Model"}</span>
        <span className="text-zinc-500">{cur?.local ? "Local" : review === "manual" ? "Review" : "Auto"}</span>
        <ChevronUp className="size-3 text-zinc-500" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 left-0 z-40 w-80 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60">
            {([false, true] as const).map((local) =>
              group(local).length ? (
                <div key={String(local)} className="p-1.5">
                  <p className="px-2 pt-1 pb-1 text-[10.5px] font-semibold tracking-wide text-muted uppercase">
                    {local ? "On your machines · chat only" : "Cloud · does the work"}
                  </p>
                  {group(local).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]", m.id === (cur?.id ?? "") && "bg-white/[0.06]")}
                    >
                      {m.local ? <Cpu className="size-3.5 shrink-0 text-muted" /> : <Cloud className="size-3.5 shrink-0 text-muted" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-white">{m.label}</span>
                        <span className="block truncate text-[11px] text-muted">{m.sub}</span>
                      </span>
                      {m.id === (cur?.id ?? "") && <span className="size-1.5 rounded-full bg-accent" />}
                    </button>
                  ))}
                </div>
              ) : null,
            )}
            {!group(true).length && (
              <p className="px-3.5 pb-2 text-[11px] text-muted">
                No local models yet. Add <b className="text-zinc-300">Ollama</b> in Services and its models show up here.
              </p>
            )}
            <div className="border-t border-white/[0.06] p-1.5">
              <p className="px-2 pt-1 pb-1 text-[10.5px] font-semibold tracking-wide text-muted uppercase">When it acts</p>
              {(["auto", "manual"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onReview(r)}
                  className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]", review === r && "bg-white/[0.06]")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-white">{r === "auto" ? "Auto" : "Review each step"}</span>
                    <span className="block text-[11px] text-muted">{r === "auto" ? "Acts on its own; only risky steps wait for you" : "Every action waits for your OK"}</span>
                  </span>
                  {review === r && <span className="size-1.5 rounded-full bg-accent" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function Composer({
  models,
  model,
  onModel,
  entities,
  busy,
  disabled,
  uploading,
  staged,
  review,
  placeholder,
  onSend,
  onStop,
  onAttach,
  onUnstage,
  onReview,
  onNew,
  onExport,
  machines = [],
  target = "",
  onTarget,
}: {
  entities: Entity[];
  busy: boolean;
  disabled?: boolean;
  uploading: boolean;
  staged: (Att & { pending?: boolean; pct?: number; preview?: string; error?: string })[];
  review: "auto" | "manual";
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onAttach: (files: FileList | null) => void;
  onUnstage: (id: string) => void;
  onReview: (r: "auto" | "manual") => void;
  onNew: () => void;
  onExport?: () => void;
  /** machine chip: "" = the Assistant picks */
  machines?: { name: string; ok: boolean }[];
  target?: string;
  onTarget?: (vm: string) => void;
  models: ModelChoice[];
  model: string;
  onModel: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const router = useRouter();
  const [skills, setSkills] = useState<Command[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/skills", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { builtIn?: { id: string; title: string }[]; installed?: { slug: string; name: string }[] } | null) => {
        if (!alive || !d) return;
        setSkills([
          ...(d.builtIn ?? []).map((b) => ({ group: "Skills" as const, cmd: b.id, hint: b.title.split(/[:(]/)[0].trim(), insert: () => `Use the ${b.title.split(/[:(]/)[0].trim()} playbook: ` })),
          ...(d.installed ?? []).map((h) => ({ group: "Skills" as const, cmd: h.slug, hint: h.name, insert: () => `Use the ${h.slug} skill: ` })),
        ]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const [connectors, setConnectors] = useState<Entity[]>([]);
  const [plus, setPlus] = useState<null | "main" | "connectors">(null);
  const { current: sessionId, off } = useAssistant();
  const offHere = off[sessionId] ?? [];
  const plusAction = (what: "files" | "/" | "@") => {
    setPlus(null);
    if (what === "files") fileInput.current?.click();
    else insertAtCaret(what);
  };
  const insertAtCaret = (t: string) => {
    const pos = area.current?.selectionStart ?? text.length;
    const lead = pos > 0 && !/\s$/.test(text.slice(0, pos)) ? " " : "";
    const next = text.slice(0, pos) + lead + t + text.slice(pos);
    setText(next);
    const at = pos + lead.length + t.length;
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };
  useEffect(() => {
    let alive = true;
    fetch("/api/connectors", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { states?: { id: string; connected: boolean; account?: string; accounts?: { email: string }[] }[] } | null) => {
        if (!alive || !d?.states) return;
        const out: Entity[] = [];
        for (const st of d.states) {
          const def = connectorDef(st.id);
          if (!def || def.kind === "builtin") continue;
          if (def.kind === "mailbox") {
            for (const a of st.accounts ?? []) out.push({ kind: "connector", name: a.email, sub: def.name, connected: true, mail: true, key: a.email, say: `Using my ${def.name} account ${a.email}, ` });
            if (!st.accounts?.length) out.push({ kind: "connector", name: def.id, sub: `${def.name} · not connected`, connected: false, mail: true });
            continue;
          }
          out.push(
            st.connected
              ? { kind: "connector", name: def.id, sub: `${def.name}${st.account ? ` · ${st.account}` : ""}`, connected: true, key: def.id, say: `Using the ${def.name} connector, ` }
              : { kind: "connector", name: def.id, sub: `${def.name} · not connected`, connected: false },
          );
        }
        // ready ones first
        setConnectors(out.sort((a, b) => Number(Boolean(b.connected)) - Number(Boolean(a.connected))));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const all = useMemo(() => [...BASE, ...COMMANDS.map((c) => ({ ...c, group: c.group ?? ("Commands" as const) })), ...skills], [skills]);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [voice, setVoice] = useState(false);
  const canVoice = useSyncExternalStore(
    () => () => {},
    voiceSupported,
    () => false,
  );
  const recog = useRef<{ stop: () => void } | null>(null);
  const dictate = () => {
    if (recog.current) {
      recog.current.stop();
      return;
    }
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    // words show up while you speak (faded in), and settle into the box when the phrase is final
    r.interimResults = true;
    r.continuous = true;
    const base = text;
    let said = "";
    r.onresult = (ev) => {
      let live = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) said += `${ev.results[i][0].transcript.trim()} `;
        else live += ev.results[i][0].transcript;
      }
      setInterim(live.trim());
      const next = `${base}${base && !base.endsWith(" ") ? " " : ""}${said}`.trimStart();
      setText(next);
      setCaret(next.length);
    };
    r.onend = () => {
      recog.current = null;
      setListening(false);
      setInterim("");
    };
    r.onerror = () => r.stop();
    recog.current = r;
    setListening(true);
    r.start();
  };

  const menu: Menu | null = useMemo(() => {
    const before = text.slice(0, caret);
    let m = /(?:^|\s)\/([a-z]+) ([\w.-]*)$/.exec(before);
    const withArg = m && all.find((c) => c.cmd === m![1] && c.pick);
    if (m && withArg) {
      const q = m[2].toLowerCase();
      const items =
        withArg.pick === "connector"
          ? connectors.filter((e) => `${e.name} ${e.sub}`.toLowerCase().includes(q))
          : entities.filter((e) => (withArg.pick === "database" ? e.kind === "database" : withArg.pick === "machine" ? e.kind === "machine" : e.kind !== "machine") && e.name.includes(q));
      return { kind: "entities", items, start: before.length - m[0].trimStart().length, end: caret, cmd: withArg };
    }
    m = /(?:^|\s)\/([a-z]*)$/.exec(before);
    if (m) {
      const q = m[1];
      const hit = all.filter((c) => !q || c.cmd.startsWith(q) || (c.label ?? c.hint).toLowerCase().includes(q));
      // keep the sections in order so the list reads like Claude Code's
      const items = GROUP_ORDER.flatMap((g) => hit.filter((c) => (c.group ?? "Commands") === g));
      return { kind: "commands", items, start: before.length - q.length - 1, end: caret };
    }
    m = /(?:^|\s)@([\w.-]*)$/.exec(before);
    if (m) {
      const q = m[1].toLowerCase();
      return { kind: "entities", items: entities.filter((e) => e.name.includes(q)), start: before.length - q.length - 1, end: caret };
    }
    return null;
  }, [text, caret, entities, all, connectors]);
  const key = menu ? `${menu.kind}:${menu.start}` : null;
  const open = Boolean(menu && menu.items.length && key !== dismissed);
  const index = menu ? Math.min(hi, Math.max(0, menu.items.length - 1)) : 0;

  const replace = (start: number, end: number, insert: string) => {
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    const pos = start + insert.length;
    setCaret(pos);
    setHi(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  };

  const choose = (i: number) => {
    if (!menu) return;
    if (menu.kind === "commands") {
      const c = menu.items[i];
      if (c.action === "review") {
        onReview(review === "auto" ? "manual" : "auto");
        return replace(menu.start, menu.end, "");
      }
      if (c.action === "new") {
        onNew();
        return replace(menu.start, menu.end, "");
      }
      if (c.action === "attach") {
        replace(menu.start, menu.end, "");
        return fileInput.current?.click();
      }
      if (c.action === "mention") return replace(menu.start, menu.end, "@");
      if (c.action === "export") {
        onExport?.();
        return replace(menu.start, menu.end, "");
      }
      if (c.action === "model") {
        setModelOpen(true);
        return replace(menu.start, menu.end, "");
      }
      if (c.href) {
        replace(menu.start, menu.end, "");
        router.push(c.href);
        return;
      }
      if (c.pick) return replace(menu.start, menu.end, `/${c.cmd} `);
      return replace(menu.start, menu.end, c.insert?.("") ?? "");
    }
    const e = menu.items[i];
    if (e.kind === "connector") {
      // not connected yet: off to Settings to connect it; connected: say which one to use
      if (!e.connected) {
        replace(menu.start, menu.end, "");
        router.push("/settings?tab=connectors");
        return;
      }
      return replace(menu.start, menu.end, e.say ?? `Using ${e.name}, `);
    }
    if (menu.cmd?.insert) return replace(menu.start, menu.end, menu.cmd.insert(e.name));
    replace(menu.start, menu.end, `@${e.name} `);
  };

  const submit = () => {
    if ((!text.trim() && !staged.length) || staged.some((f) => f.pending) || busy || disabled) return;
    onSend(text.trim());
    setText("");
    setCaret(0);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && menu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setHi((index + 1) % menu.items.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setHi((index - 1 + menu.items.length) % menu.items.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return choose(index);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setDismissed(key);
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative">
      {open && menu && (
        <div className="absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-xl border border-white/[0.09] bg-pop shadow-2xl shadow-black/60">
          <div className="scroll-thin max-h-80 overflow-y-auto py-1.5">
            {menu.kind === "commands"
              ? menu.items.map((c, i) => {
                  const g = c.group ?? "Commands";
                  const head = i === 0 || (menu.items[i - 1].group ?? "Commands") !== g;
                  const label = c.label ?? `/${c.cmd}`;
                  const right =
                    c.action === "review" ? (review === "auto" ? "Auto" : "Review each step") : c.action === "model" ? (models.find((m) => m.id === model)?.label ?? "") : c.label ? c.hint : c.hint;
                  return (
                    <div key={`${g}-${c.cmd}`}>
                      {head && <p className={cx("px-4 pt-2 pb-1 text-[11.5px] text-zinc-500", i > 0 && "mt-1 border-t border-white/[0.06] pt-2.5")}>{g}</p>}
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(i)}
                        onMouseEnter={() => setHi(i)}
                        className={cx("flex w-full items-center gap-3 px-4 py-[7px] text-left text-[13.5px]", i === index ? "bg-[#2b5dd6]/90 text-white" : "text-zinc-200")}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {label}
                          {c.pick && <span className={cx("ml-2 font-mono text-[11px]", i === index ? "text-white/70" : "text-zinc-500")}>{c.pick}</span>}
                        </span>
                        {right && <span className={cx("max-w-[45%] shrink-0 truncate text-[12px]", i === index ? "text-white/80" : "text-zinc-500")}>{right}</span>}
                      </button>
                    </div>
                  );
                })
              : menu.items.map((e, i) => {
                  const Icon = e.kind === "connector" ? (e.mail ? Mail : Plug) : e.kind === "machine" ? Server : e.type ? TYPE_ICON[e.type] : FolderGit2;
                  return (
                    <button
                      key={`${e.kind}-${e.name}`}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => choose(i)}
                      onMouseEnter={() => setHi(i)}
                      className={cx("flex w-full items-center gap-2.5 px-4 py-[7px] text-left text-[13.5px]", i === index ? "bg-[#2b5dd6]/90 text-white" : "text-zinc-200")}
                    >
                      <Icon className={cx("size-3.5 shrink-0", i === index ? "text-white/80" : "text-zinc-500")} />
                      <span className={cx("font-medium", e.kind === "connector" && !e.connected && i !== index && "text-zinc-400")}>{e.name}</span>
                      <span className={cx("truncate text-[12px]", i === index ? "text-white/70" : "text-zinc-500")}>{e.sub}</span>
                      {e.kind === "connector" && !e.connected && <span className={cx("ml-auto shrink-0 text-[11px]", i === index ? "text-white/80" : "text-accent-soft")}>Connect →</span>}
                    </button>
                  );
                })}
          </div>
        </div>
      )}

      {staged.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {staged.map((f) => (
            <div
              key={f.id}
              title={f.error ? `${f.name}: ${f.error}` : f.pending ? `Uploading ${f.name}…` : f.name}
              className={cx(
                "relative flex items-center gap-2 overflow-hidden rounded-xl border bg-panel text-xs text-ink",
                f.error ? "border-[var(--critical)]/50" : "border-white/10",
                f.preview ? "p-1 pr-2" : "px-2.5 py-1.5",
              )}
            >
              {f.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.preview} alt="" className={cx("size-12 rounded-lg object-cover transition-opacity", f.pending && "opacity-40")} />
              ) : (
                <FileText className={cx("size-4 shrink-0", f.pending && "opacity-40")} />
              )}
              <span className={cx("max-w-40 truncate", f.pending && "text-zinc-500")}>
                {f.name}
                <span className="block text-[10.5px] text-zinc-500">{f.error ? "couldn't upload" : f.pending ? `uploading ${f.pct ?? 0}%` : fmtBytes(f.size)}</span>
              </span>
              {f.pending && <Loader2 className="size-3.5 animate-spin text-zinc-400" />}
              <button onClick={() => onUnstage(f.id)} className="text-muted hover:text-white" aria-label="Remove">
                <X className="size-3" />
              </button>
              {f.pending && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/[0.06]">
                  <span className="block h-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${f.pct ?? 0}%` }} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {voice ? (
        <VoiceMode
          sessionId={sessionId}
          context={entities.slice(0, 120).map((e) => `${e.name}: ${e.sub}`).join("\n")}
          onPlan={(plan) => onSend(plan)}
          onClose={() => setVoice(false)}
        />
      ) : (
      <div className="rounded-2xl border border-white/[0.09] bg-pop shadow-lg shadow-black/20 transition-colors focus-within:border-white/[0.18]">
        <div className="flex items-end gap-1 px-2 py-2">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => onAttach(e.target.files)} />
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setPlus((p) => (p ? null : "main"))}
              disabled={uploading}
              className={cx("grid size-9 place-items-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white", plus && "bg-white/[0.06] text-white")}
              aria-label="Add files, commands and connectors"
              aria-expanded={Boolean(plus)}
              title="Add"
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-[18px]" />}
            </button>
            {plus && (
              <>
                <button className="fixed inset-0 z-30 cursor-default" aria-label="Close menu" onClick={() => setPlus(null)} />
                <div className="absolute bottom-11 left-0 z-40 flex items-end gap-1.5">
                  <div className="w-60 rounded-xl border border-white/[0.09] bg-pop p-1.5 shadow-2xl shadow-black/50">
                    {(
                      [
                        [Paperclip, "Add files or photos", "files"],
                        [Slash, "Slash commands", "/"],
                        [AtSign, "Mention a project or machine", "@"],
                      ] as const
                    ).map(([Icon, label, what]) => (
                      <button key={label} onClick={() => plusAction(what)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-zinc-200 hover:bg-white/[0.06]">
                        <Icon className="size-4 text-zinc-400" /> {label}
                      </button>
                    ))}
                    <button
                      onClick={() => setPlus((p) => (p === "connectors" ? "main" : "connectors"))}
                      onMouseEnter={() => setPlus("connectors")}
                      className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-zinc-200 hover:bg-white/[0.06]", plus === "connectors" && "bg-white/[0.06]")}
                    >
                      <Plug className="size-4 text-zinc-400" /> <span className="flex-1">Connectors</span> <ChevronRight className="size-3.5 text-zinc-500" />
                    </button>
                  </div>
                  {plus === "connectors" && (
                    <div className="w-72 rounded-xl border border-white/[0.09] bg-pop p-1.5 shadow-2xl shadow-black/50">
                      <button onClick={() => (setPlus(null), router.push("/settings?tab=connectors"))} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-zinc-200 hover:bg-white/[0.06]">
                        <LayoutGrid className="size-4 text-zinc-400" /> Browse connectors
                      </button>
                      <button onClick={() => (setPlus(null), router.push("/settings?tab=connectors"))} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-zinc-200 hover:bg-white/[0.06]">
                        <Settings2 className="size-4 text-zinc-400" /> Manage connectors
                      </button>
                      <div className="my-1.5 h-px bg-white/[0.07]" />
                      {connectors.filter((c) => c.connected && c.key).length === 0 ? (
                        <p className="px-2.5 py-2 text-[12.5px] text-zinc-500">Nothing connected yet.</p>
                      ) : (
                        <div className="max-h-72 overflow-y-auto">
                          {connectors
                            .filter((c) => c.connected && c.key)
                            .map((c) => {
                              const on = !offHere.includes(c.key!);
                              return (
                                <button
                                  key={c.key}
                                  onClick={() => toggleConnector(sessionId, c.key!)}
                                  role="switch"
                                  aria-checked={on}
                                  title={on ? "On for this conversation: click to switch off" : "Off for this conversation: click to switch on"}
                                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-200 hover:bg-white/[0.06]"
                                >
                                  {c.mail ? <Mail className="size-4 shrink-0 text-zinc-400" /> : <Plug className="size-4 shrink-0 text-zinc-400" />}
                                  <span className={cx("min-w-0 flex-1 truncate", !on && "text-zinc-500")}>{c.mail ? c.name : c.sub.split(" · ")[0]}</span>
                                  <span className={cx("relative h-[18px] w-8 shrink-0 rounded-full transition-colors", on ? "bg-[#2b5dd6]" : "bg-white/15")}>
                                    <span className={cx("absolute top-[2px] size-[14px] rounded-full bg-white transition-all", on ? "left-[16px]" : "left-[2px]")} />
                                  </span>
                                </button>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <textarea
            ref={area}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setDismissed(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKey}
            onPaste={(e) => {
              // pasted files become attachments; text pastes as usual
              if (e.clipboardData.files.length) {
                e.preventDefault();
                onAttach(e.clipboardData.files);
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="block max-h-56 min-h-9 flex-1 resize-none bg-transparent py-2 text-[14.5px] leading-relaxed text-white placeholder:text-zinc-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={dictate}
            className={cx("grid size-9 shrink-0 place-items-center rounded-lg transition-colors", listening ? "bg-[var(--critical)]/20 text-[var(--critical-text)]" : "text-zinc-400 hover:bg-white/[0.06] hover:text-white")}
            aria-label={listening ? "Stop dictation" : "Dictate"}
            title={listening ? "Stop dictation" : "Dictate"}
          >
            <Mic className={cx("size-[17px]", listening && "animate-pulse")} />
          </button>
          {canVoice && (
            <button
              type="button"
              onClick={() => {
                recog.current?.stop();
                setVoice(true);
              }}
              disabled={busy || disabled}
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-zinc-300 transition-colors hover:bg-white/[0.1] hover:text-white disabled:opacity-40"
              aria-label="Use voice mode"
              title="Use voice mode"
            >
              <AudioLines className="size-[17px]" />
            </button>
          )}
          {busy ? (
            <button type="button" onClick={onStop} className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.1] text-white hover:bg-white/[0.16]" aria-label="Stop">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={(!text.trim() && !staged.some((f) => !f.pending && !f.error)) || staged.some((f) => f.pending) || disabled}
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-black transition-opacity hover:bg-white/90 disabled:bg-white/[0.07] disabled:text-zinc-600"
              aria-label="Send"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
        {listening && interim && (
          <div className="-mt-1 px-12 pb-2.5 text-[14px] leading-relaxed text-zinc-400">
            <FadeWords text={interim} />
          </div>
        )}
      </div>
      )}
      <div className="mt-1.5 flex items-center gap-0.5 px-1">
        {onTarget && <MachineChip machines={machines} target={target} onTarget={onTarget} />}
        <ModelPicker value={model} models={models} onChange={onModel} review={review} onReview={onReview} open={modelOpen} setOpen={setModelOpen} />
        <span className="flex-1" />
        <span className="hidden text-[11px] text-zinc-600 sm:block">/ for commands · @ to mention</span>
      </div>
    </div>
  );
}

/** Where the work happens: the Assistant picks, or you pin a machine. */
function MachineChip({ machines, target, onTarget }: { machines: { name: string; ok: boolean }[]; target: string; onTarget: (vm: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-zinc-300 hover:bg-white/[0.06] hover:text-white" title="Which machine to work on">
        <Laptop className="size-3.5 text-zinc-500" />
        <span>{target || "Any machine"}</span>
        <ChevronUp className="size-3 text-zinc-500" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 left-0 z-40 w-64 overflow-hidden rounded-xl border border-white/[0.09] bg-pop py-1.5 shadow-2xl shadow-black/60">
            <p className="px-3.5 pt-1 pb-1.5 text-[11.5px] text-zinc-500">Environment</p>
            {[{ name: "", ok: true }, ...machines].map((m) => (
              <button
                key={m.name || "any"}
                type="button"
                onClick={() => {
                  onTarget(m.name);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left text-[13px] text-zinc-200 hover:bg-white/[0.06]"
              >
                {m.name ? <Server className="size-3.5 text-zinc-500" /> : <Sparkles className="size-3.5 text-zinc-500" />}
                <span className="flex-1">{m.name || "Any machine (the Assistant picks)"}</span>
                {m.name && <span className={cx("size-1.5 rounded-full", m.ok ? "bg-[var(--good)]" : "bg-zinc-600")} />}
                {target === m.name && <Check className="size-3.5 text-white" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
