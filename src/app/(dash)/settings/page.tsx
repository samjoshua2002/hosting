"use client";

import { Blocks, Brain, Code2, Gauge, ScrollText, Search, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AutopilotSettings, InstructionsEditor, MemoryList, ToolsList } from "@/components/assistant-panel";
import { CodeSettings } from "@/components/code-settings";
import { Customize } from "@/components/customize";
import { cx } from "@/components/ui";
import { useSearchParam } from "@/lib/client";

type Tab = "general" | "instructions" | "memory" | "customize" | "code" | "autopilot" | "capabilities";
const GROUPS: { id: Tab; label: string; icon: LucideIcon; title: string; hint?: string }[][] = [
  [
    { id: "general", label: "General", icon: Gauge, title: "General", hint: "What the Assistant is connected to at a glance." },
    { id: "instructions", label: "Instructions", icon: ScrollText, title: "Instructions", hint: "Standing rules it follows in every conversation." },
    { id: "memory", label: "Memory", icon: Brain, title: "Memory", hint: "Preferences you told it and lessons it learned, used in every conversation." },
  ],
  [
    { id: "customize", label: "Customize", icon: Blocks, title: "Customize" },
    { id: "code", label: "Code", icon: Code2, title: "Code", hint: "How the Assistant works on your projects." },
  ],
  [
    { id: "autopilot", label: "Autopilot", icon: ShieldCheck, title: "Autopilot", hint: "Checks and fixes the fleet on its own every 15 minutes." },
    { id: "capabilities", label: "Capabilities", icon: Sparkles, title: "Capabilities", hint: "Everything the Assistant can do." },
  ],
];
const ALL = GROUPS.flat();
const LEGACY: Record<string, Tab> = { connectors: "customize", skills: "customize", tools: "capabilities" };

/** Settings shared by every conversation, laid out like Claude's settings. */
export default function SettingsPage() {
  const asked = useSearchParam("tab");
  const [picked, setPicked] = useState<Tab | null>(null);
  const [q, setQ] = useState("");
  const fromUrl = (asked && (LEGACY[asked] ?? (ALL.some((t) => t.id === asked) ? (asked as Tab) : null))) || null;
  const tab: Tab = picked ?? fromUrl ?? "customize";
  const cur = ALL.find((t) => t.id === tab)!;
  const go = (id: Tab) => {
    setPicked(id);
    window.history.replaceState(null, "", `/settings?tab=${id}`);
  };
  const body: Record<Tab, ReactNode> = {
    general: <GeneralSummary go={go} />,
    instructions: <div className="max-w-3xl"><InstructionsEditor /></div>,
    memory: <div className="max-w-3xl"><MemoryList /></div>,
    customize: <Customize />,
    code: <div className="max-w-4xl"><CodeSettings /></div>,
    autopilot: <div className="max-w-3xl"><AutopilotSettings /></div>,
    capabilities: <div className="max-w-3xl"><ToolsList /></div>,
  };
  return (
    <div className="flex min-h-[calc(100dvh-3rem)]">
      <nav className="w-64 shrink-0 border-r border-white/[0.06] px-3 py-5">
        <p className="mb-3 px-2 text-[17px] font-semibold text-white">Settings</p>
        <label className="mb-4 flex items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-1.5">
          <Search className="size-3.5 text-zinc-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-zinc-600" />
        </label>
        {GROUPS.map((g, i) => {
          const items = g.filter((t) => !q || `${t.label} ${t.hint ?? ""}`.toLowerCase().includes(q.toLowerCase()));
          if (!items.length) return null;
          return (
            <div key={i} className={cx("space-y-0.5", i > 0 && "mt-3 border-t border-white/[0.06] pt-3")}>
              {items.map(({ id, label, icon: Icon }) => (
                <button key={id} onClick={() => go(id)} className={cx("flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[13.5px] transition-colors", tab === id ? "bg-white/[0.08] text-white" : "text-zinc-300 hover:bg-white/[0.04] hover:text-white")}>
                  <Icon className={cx("size-4", tab === id ? "text-white" : "text-zinc-500")} strokeWidth={1.75} /> {label}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      <main className="min-w-0 flex-1 px-10 py-7">
        {tab !== "customize" && (
          <div className="mb-6">
            <h1 className="text-[20px] font-semibold text-white">{cur.title}</h1>
            {cur.hint && <p className="mt-1 text-sm text-zinc-400">{cur.hint}</p>}
          </div>
        )}
        {body[tab]}
      </main>
    </div>
  );
}

function GeneralSummary({ go }: { go: (t: Tab) => void }) {
  return (
    <div className="grid max-w-4xl grid-cols-1 gap-3 md:grid-cols-3">
      {(
        [
          ["Connectors", "GitHub, Vercel, Render, Slack, MCP servers and more. Connect once; the Assistant uses them when a task needs them.", "customize"],
          ["Code", "Branch prefix, review mode, screenshot checks, summaries, reply style.", "code"],
          ["Instructions", "Rules it follows in every conversation.", "instructions"],
          ["Memory", "What it remembers about you and your fleet.", "memory"],
          ["Autopilot", "Check and fix the fleet every 15 minutes.", "autopilot"],
          ["Capabilities", "Every tool it can use.", "capabilities"],
        ] as [string, string, Tab][]
      ).map(([t, d, id]) => (
        <button key={id} onClick={() => go(id)} className="rounded-xl border border-white/[0.06] bg-panel p-4 text-left transition-colors hover:border-white/[0.14]">
          <p className="text-[14px] font-medium text-white">{t}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{d}</p>
        </button>
      ))}
    </div>
  );
}
