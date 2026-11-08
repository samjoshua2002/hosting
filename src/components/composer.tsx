"use client";

import { Cpu, Database, FileText, FolderGit2, Globe, Hash, Loader2, Paperclip, SendHorizonal, Server, ShieldCheck, Square, Wrench, X, Zap, type LucideIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Att } from "@/lib/assistant-items";
import { projectType, TYPE_LABEL, type ProjectType } from "@/lib/project-type";
import type { VmInfo, VmStatus } from "@/lib/types";
import { Button, cx } from "./ui";

export interface Entity {
  name: string;
  kind: "project" | "database" | "machine";
  type?: ProjectType;
  sub: string;
}

const TYPE_ICON: Record<ProjectType, LucideIcon> = { website: Globe, service: Server, worker: Cpu, database: Database, tool: Wrench };

type Pick = "project" | "database" | "machine";
interface Command {
  cmd: string;
  hint: string;
  pick?: Pick;
  /** text that replaces the command (n = picked name) */
  insert?: (n: string) => string;
  action?: "review" | "new";
}

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
  { cmd: "review", hint: "Switch between auto and review each step", action: "review" },
  { cmd: "new", hint: "Start a new session", action: "new" },
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

type Menu = { kind: "commands"; items: Command[]; start: number; end: number } | { kind: "entities"; items: Entity[]; start: number; end: number; cmd?: Command };

export function Composer({
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
}: {
  entities: Entity[];
  busy: boolean;
  disabled?: boolean;
  uploading: boolean;
  staged: Att[];
  review: "auto" | "manual";
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onAttach: (files: FileList | null) => void;
  onUnstage: (id: string) => void;
  onReview: (r: "auto" | "manual") => void;
  onNew: () => void;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const menu: Menu | null = useMemo(() => {
    const before = text.slice(0, caret);
    let m = /(?:^|\s)\/([a-z]+) ([\w.-]*)$/.exec(before);
    const withArg = m && COMMANDS.find((c) => c.cmd === m![1] && c.pick);
    if (m && withArg) {
      const q = m[2].toLowerCase();
      const items = entities.filter((e) => (withArg.pick === "database" ? e.kind === "database" : withArg.pick === "machine" ? e.kind === "machine" : e.kind !== "machine") && e.name.includes(q));
      return { kind: "entities", items, start: before.length - m[0].trimStart().length, end: caret, cmd: withArg };
    }
    m = /(?:^|\s)\/([a-z]*)$/.exec(before);
    if (m) {
      const q = m[1];
      return { kind: "commands", items: COMMANDS.filter((c) => c.cmd.startsWith(q)), start: before.length - q.length - 1, end: caret };
    }
    m = /(?:^|\s)@([\w.-]*)$/.exec(before);
    if (m) {
      const q = m[1].toLowerCase();
      return { kind: "entities", items: entities.filter((e) => e.name.includes(q)), start: before.length - q.length - 1, end: caret };
    }
    return null;
  }, [text, caret, entities]);
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
      if (c.pick) return replace(menu.start, menu.end, `/${c.cmd} `);
      return replace(menu.start, menu.end, c.insert?.("") ?? "");
    }
    const e = menu.items[i];
    if (menu.cmd?.insert) return replace(menu.start, menu.end, menu.cmd.insert(e.name));
    replace(menu.start, menu.end, `@${e.name} `);
  };

  const submit = () => {
    if ((!text.trim() && !staged.length) || busy || disabled) return;
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
        <div className="absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-2xl shadow-black/60">
          <p className="border-b border-white/[0.06] px-4 py-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
            {menu.kind === "commands" ? "Commands" : menu.cmd ? `/${menu.cmd.cmd} · pick ${menu.cmd.pick}` : "Projects, databases, machines"}
          </p>
          <div className="scroll-thin max-h-72 overflow-y-auto p-1.5">
            {menu.kind === "commands"
              ? menu.items.map((c, i) => (
                  <button
                    key={c.cmd}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(i)}
                    onMouseEnter={() => setHi(i)}
                    className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === index && "bg-white/[0.07]")}
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-chip text-ink">
                      {c.action === "review" ? <ShieldCheck className="size-3.5" /> : c.pick ? <Hash className="size-3.5" /> : <Zap className="size-3.5" />}
                    </span>
                    <span className="font-mono text-sm text-white">/{c.cmd}</span>
                    {c.pick && <span className="rounded bg-white/[0.06] px-1.5 font-mono text-[11px] text-muted">{c.pick}</span>}
                    <span className="truncate text-sm text-muted">{c.action === "review" ? `${c.hint} (now ${review === "auto" ? "auto" : "review"})` : c.hint}</span>
                  </button>
                ))
              : menu.items.map((e, i) => {
                  const Icon = e.kind === "machine" ? Server : e.type ? TYPE_ICON[e.type] : FolderGit2;
                  return (
                    <button
                      key={`${e.kind}-${e.name}`}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => choose(i)}
                      onMouseEnter={() => setHi(i)}
                      className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === index && "bg-white/[0.07]")}
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-chip text-ink">
                        <Icon className="size-3.5" />
                      </span>
                      <span className="text-sm font-medium text-white">{e.name}</span>
                      <span className="truncate text-xs text-muted">{e.sub}</span>
                    </button>
                  );
                })}
          </div>
        </div>
      )}

      {staged.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {staged.map((f) => (
            <span key={f.id} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-panel px-2 py-1 text-xs text-ink">
              <FileText className="size-3.5" /> {f.name}
              <button onClick={() => onUnstage(f.id)} className="text-muted hover:text-white" aria-label="Remove">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="rounded-2xl border border-white/[0.1] bg-panel shadow-xl focus-within:border-white/20">
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
          rows={2}
          placeholder={placeholder}
          className="block max-h-56 min-h-[56px] w-full resize-none bg-transparent px-4 pt-3 text-sm text-white placeholder:text-muted focus:outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => onAttach(e.target.files)} />
          <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-white/5 hover:text-white" aria-label="Attach files" title="Attach files">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}/`);
              setCaret(text.length + (text && !text.endsWith(" ") ? 2 : 1));
              area.current?.focus();
            }}
            className="grid size-8 place-items-center rounded-lg font-mono text-sm text-muted hover:bg-white/5 hover:text-white"
            title="Commands"
          >
            /
          </button>
          <div className="ml-1 flex shrink-0 rounded-lg border border-white/[0.08] p-0.5 text-[11.5px]">
            {(["auto", "manual"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onReview(r)}
                className={cx("rounded-md px-2 py-0.5 whitespace-nowrap", review === r ? "bg-white/[0.1] text-white" : "text-muted hover:text-white")}
                title={r === "auto" ? "Acts on its own; only destructive steps wait for you" : "Every action waits for your approval (commits show the diff)"}
              >
                {r === "auto" ? "Auto" : "Review"}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <span className="mr-2 hidden text-[11px] whitespace-nowrap text-muted 2xl:inline">/ commands · @ to tag</span>
          {busy ? (
            <Button type="button" variant="danger" size="sm" onClick={onStop}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button type="button" variant="primary" size="sm" onClick={submit} disabled={(!text.trim() && !staged.length) || disabled}>
              <SendHorizonal className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
