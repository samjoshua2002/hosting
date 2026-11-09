"use client";

// Settings → Code: how the Assistant works (like Claude Code's settings). Some are saved with the dashboard
// (they change what the Assistant does), the display ones are kept in this browser.
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, useStored } from "@/lib/client";
import { setReview, useAssistant } from "./assistant-store";
import { cx } from "./ui";

interface Prefs {
  branchPrefix: string;
  verifyScreenshots: boolean;
  summaryNextSteps: boolean;
  replyStyle: "default" | "concise" | "detailed";
}

function Row({ title, desc, tag, children }: { title: string; desc: string; tag?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 border-b border-white/[0.06] py-5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[14.5px] text-white">
          {title}
          {tag && <span className="rounded-md border border-white/10 px-1.5 py-px text-[10.5px] text-zinc-400">{tag}</span>}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{desc}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className={cx("relative h-6 w-11 rounded-full transition-colors", on ? "bg-[#2b6fe0]" : "bg-white/15")}>
      <span className={cx("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg bg-white/[0.05] p-0.5">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={cx("rounded-md px-3 py-1.5 text-[13px] transition-colors", value === v ? "bg-white/[0.12] text-white" : "text-zinc-400 hover:text-white")}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function CodeSettings() {
  const st = useAssistant();
  const [p, setP] = useState<Prefs | null>(null);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [prefix, setPrefix] = useState("");
  const [detail, setDetail] = useStored<"normal" | "verbose">("hosting.assistant.detail", "normal");
  const [suggest, setSuggest] = useStored<boolean>("hosting.assistant.suggest", true);
  useEffect(() => {
    api<Prefs>("/api/assistant/preferences").then((x) => {
      setP(x);
      setPrefix(x.branchPrefix);
    }, () => {});
  }, []);
  const save = async (patch: Partial<Prefs>) => {
    if (!p) return;
    setP({ ...p, ...patch });
    setSaved("saving");
    try {
      const next = await api<Prefs>("/api/assistant/preferences", patch);
      setP(next);
      setPrefix(next.branchPrefix);
      setSaved("saved");
      setTimeout(() => setSaved("idle"), 1500);
    } catch {
      setSaved("idle");
    }
  };
  if (!p) return <p className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" /> Loading…</p>;
  return (
    <div>
      <div className="mb-1 flex h-5 items-center justify-end text-[12px]">
        {saved === "saving" && <span className="text-zinc-500">Saving…</span>}
        {saved === "saved" && (
          <span className="flex items-center gap-1 text-[var(--good)]">
            <Check className="size-3" /> Saved
          </span>
        )}
      </div>
      <Row title="Branch prefix" desc="Added to the start of every branch name the Assistant creates.">
        <input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          onBlur={() => prefix !== p.branchPrefix && void save({ branchPrefix: prefix })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="w-56 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-[13px] text-white focus:border-white/25"
        />
      </Row>
      <Row title="When it acts" desc="Auto: it works on its own and only risky steps (deleting, overwriting, paid actions, outside changes) wait for you. Review: every action waits for your OK.">
        <Seg value={st.review} options={[["auto", "Auto"], ["manual", "Review each step"]]} onChange={(v) => setReview(v)} />
      </Row>
      <Row title="Verify with screenshots" desc="Before saying a site or page is done, it opens it in a real browser, looks at it and shows you the screenshot.">
        <Switch on={p.verifyScreenshots} onChange={(v) => void save({ verifyScreenshots: v })} />
      </Row>
      <Row title="Summary and next steps" desc="End finished tasks with a short summary and suggested next steps.">
        <Switch on={p.summaryNextSteps} onChange={(v) => void save({ summaryNextSteps: v })} />
      </Row>
      <Row title="Prompt suggestions" tag="This browser" desc="Show the suggested follow-ups as one-click chips under its reply.">
        <Switch on={suggest} onChange={setSuggest} />
      </Row>
      <Row title="Default transcript view" tag="This browser" desc="How much detail conversations show: steps folded (Normal) or every step's output open (Verbose).">
        <Seg value={detail} options={[["normal", "Normal"], ["verbose", "Verbose"]]} onChange={setDetail} />
      </Row>
      <Row title="Reply style" desc="How it writes its answers.">
        <select value={p.replyStyle} onChange={(e) => void save({ replyStyle: e.target.value as Prefs["replyStyle"] })} className="w-48 rounded-lg border border-white/10 bg-[#141416] px-3 py-1.5 text-[13px] text-white">
          <option value="default">Default</option>
          <option value="concise">Concise</option>
          <option value="detailed">Detailed</option>
        </select>
      </Row>
    </div>
  );
}
