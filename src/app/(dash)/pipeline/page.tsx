"use client";

import { FolderGit2, Server } from "lucide-react";
import { useState } from "react";
import { ClusterCanvas } from "@/components/canvas";
import { ProjectCanvas } from "@/components/project-canvas";
import { cx } from "@/components/ui";

export default function PipelinePage() {
  const [view, setView] = useState<"projects" | "machines">("projects");
  return (
    <div className="relative h-[calc(100dvh-49px)]">
      {view === "projects" ? <ProjectCanvas /> : <ClusterCanvas />}
      <div className="absolute top-3 left-4 z-20 flex rounded-xl border border-line-strong bg-panel/90 p-1 shadow-xl backdrop-blur">
        {(
          [
            ["projects", "Projects", FolderGit2],
            ["machines", "Machines", Server],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={cx("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors", view === id ? "bg-white/[0.1] text-white font-medium [&_svg]:text-[var(--accent)]" : "text-muted hover:text-white")}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}
