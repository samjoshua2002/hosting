"use client";

import { Brain, GraduationCap, Plug, ScrollText, Settings, ShieldCheck, Wrench, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AutopilotSettings, Connectors, InstructionsEditor, MemoryList, SkillsList, ToolsList } from "@/components/assistant-panel";
import { PageHero } from "@/components/page-hero";
import { Card, cx } from "@/components/ui";
import { useSearchParam } from "@/lib/client";

type Tab = "connectors" | "instructions" | "memory" | "skills" | "autopilot" | "tools";
const TABS: { id: Tab; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "connectors", label: "Connectors", icon: Plug, hint: "Everything the Assistant can reach: GitHub, AI models, machines, MCP servers and more. It uses them by itself when a task needs them." },
  { id: "instructions", label: "Instructions", icon: ScrollText, hint: "Standing rules it follows in every conversation." },
  { id: "memory", label: "Memory", icon: Brain, hint: "Preferences you told it and lessons it learned. Used in every conversation." },
  { id: "skills", label: "Skills", icon: GraduationCap, hint: "Playbooks it loads when a task needs them: built in, plus any installed from skills-hub.ai." },
  { id: "autopilot", label: "Autopilot", icon: ShieldCheck, hint: "Checks and fixes the fleet on its own every 15 minutes." },
  { id: "tools", label: "Tools", icon: Wrench, hint: "Everything the Assistant can do." },
];

/** Settings shared by every conversation: set once here, the Assistant uses them automatically. */
export default function SettingsPage() {
  const asked = useSearchParam("tab") as Tab | null;
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (TABS.some((t) => t.id === asked) ? (asked as Tab) : "connectors");
  const current = TABS.find((t) => t.id === tab)!;
  const body: Record<Tab, ReactNode> = {
    connectors: <Connectors />,
    instructions: <InstructionsEditor />,
    memory: <MemoryList />,
    skills: <SkillsList />,
    autopilot: <AutopilotSettings />,
    tools: <ToolsList />,
  };
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-10 py-8">
      <PageHero eyebrow="Assistant" title="Settings" icon={<Settings className="size-6" />} desc="Set things up once; every conversation uses them automatically." />
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6">
        <nav className="space-y-0.5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`/settings?tab=${id}`}
              onClick={(e) => {
                e.preventDefault();
                setPicked(id);
                window.history.replaceState(null, "", `/settings?tab=${id}`);
              }}
              className={cx("flex h-9 items-center gap-2.5 rounded-md px-3 text-[13px] transition-colors", tab === id ? "bg-white/[0.07] text-white" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100")}
            >
              <Icon className={cx("size-4", tab === id ? "text-[var(--accent)]" : "text-zinc-500")} strokeWidth={1.75} /> {label}
            </a>
          ))}
        </nav>
        <Card className="min-h-[420px] p-6">
          <h2 className="text-[15px] font-semibold text-white">{current.label}</h2>
          <p className="mt-1 mb-5 text-sm text-zinc-400">{current.hint}</p>
          <div className="max-w-3xl">{body[tab]}</div>
        </Card>
      </div>
    </div>
  );
}
