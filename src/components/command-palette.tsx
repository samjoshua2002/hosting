"use client";

import { Boxes, CornerDownLeft, FolderGit2, MessagesSquare, Plus, Search, Server, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isService } from "@/lib/catalog";
import { useCluster } from "./cluster";
import { NAV } from "./nav";
import { cx } from "./ui";

interface Hit {
  label: string;
  sub: string;
  href: string;
  icon: LucideIcon;
}

/** ⌘K: jump to any page, project, service or machine, or start a common action. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { vms, status } = useCluster();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const hits = useMemo<Hit[]>(() => {
    const projects = new Map<string, { vm: string[]; service: boolean }>();
    for (const v of vms)
      for (const p of status[v.name]?.agent?.projects ?? []) {
        const e = projects.get(p.manifest.name) ?? { vm: [], service: isService(p.manifest) };
        e.vm.push(v.name);
        projects.set(p.manifest.name, e);
      }
    const all: Hit[] = [
      { label: "Deploy a project", sub: "Import from GitHub or start from a template", href: "/projects?new=1", icon: Plus },
      { label: "Add a service", sub: "Databases, admin tools, apps", href: "/services#catalog", icon: Boxes },
      { label: "Add a machine", sub: "Paste its SSH command", href: "/machines?add=1", icon: Server },
      { label: "Ask the Assistant", sub: "It does the work for you", href: "/assistant", icon: MessagesSquare },
      ...NAV.flatMap((g) => g.items).map((n) => ({ label: n.label, sub: "Page", href: n.href, icon: n.icon })),
      ...[...projects].map(([name, e]) => ({ label: name, sub: `${e.service ? "Service" : "Project"} · ${e.vm.join(", ")}`, href: `/projects/${name}`, icon: e.service ? Boxes : FolderGit2 })),
      ...vms.map((v) => ({ label: v.name, sub: status[v.name]?.ok ? "Machine · online" : "Machine · unreachable", href: "/machines", icon: Server })),
    ];
    const t = q.trim().toLowerCase();
    return t ? all.filter((h) => h.label.toLowerCase().includes(t) || h.sub.toLowerCase().includes(t)).slice(0, 12) : all.slice(0, 12);
  }, [q, vms, status]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    setQ("");
    router.push(h.href);
  };
  const index = Math.min(hi, Math.max(0, hits.length - 1));

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[14vh]" onMouseDown={onClose}>
      <div className="w-[560px] overflow-hidden rounded-2xl border border-[var(--line-strong)] bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-4">
          <Search className="size-4 text-[var(--accent)]" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((index + 1) % Math.max(1, hits.length));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((index - 1 + hits.length) % Math.max(1, hits.length));
              }
              if (e.key === "Enter") go(hits[index]);
            }}
            placeholder="Search pages, projects, services, machines…"
            className="h-12 w-full bg-transparent text-sm text-white outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-[var(--line-strong)] px-1.5 text-[10px] text-muted">esc</kbd>
        </div>
        <div className="scroll-thin max-h-[52vh] overflow-y-auto p-1.5">
          {hits.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">Nothing matches.</p>}
          {hits.map((h, i) => (
            <button
              key={`${h.href}-${h.label}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => go(h)}
              className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === index && "bg-white/[0.06]")}
            >
              <span className="grid size-8 place-items-center rounded-lg border border-[var(--line)] bg-[var(--panel-2)]">
                <h.icon className="size-4 text-[var(--accent)]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-white">{h.label}</span>
                <span className="block truncate text-xs text-muted">{h.sub}</span>
              </span>
              {i === index && <CornerDownLeft className="size-3.5 text-muted" />}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
