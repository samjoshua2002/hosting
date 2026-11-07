"use client";

import { Database, FolderGit2, LayoutDashboard, LogOut, MessagesSquare, RefreshCw, Server, ShieldCheck, SquareTerminal, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { api } from "@/lib/client";
import { useCluster } from "./cluster";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/pipeline", label: "Pipeline", icon: Workflow },
  { href: "/run", label: "Run", icon: SquareTerminal },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/databases", label: "Databases", icon: Database },
  { href: "/assistant", label: "Assistant", icon: MessagesSquare },
  { href: "/machines", label: "Machines", icon: Server },
  { href: "/security", label: "Security", icon: ShieldCheck },
];

export function Shell({ children }: { children: ReactNode }) {
  const { vms, status, checking, refresh, auto, setAuto } = useCluster();
  const online = vms.filter((v) => status[v.name]?.ok).length;
  const anyChecking = Object.values(checking).some(Boolean);

  const logout = async () => {
    await api("/api/auth/logout", {}).catch(() => {});
    window.location.href = "/login";
  };

  return (
    <div className="flex min-h-dvh flex-row">
      <aside className="sticky top-0 flex h-dvh w-56 shrink-0 flex-col gap-1 border-r border-white/[0.06] bg-[var(--sidebar)]/80 px-3 py-4 backdrop-blur">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2">
          <span className="grid size-7 place-items-center rounded-lg bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40">
            <span className="size-2 rounded-full bg-[var(--accent-soft)]" />
          </span>
          <span className="text-sm font-semibold tracking-tight">hosting</span>
        </Link>
        <Suspense fallback={<Nav path={null} />}>
          <NavWithPath />
        </Suspense>
        <div className="flex-1" />
        <button
          onClick={logout}
          className="flex items-center gap-2.5 rounded-full px-3 py-1.5 text-sm text-muted hover:bg-white/5 hover:text-white"
        >
          <LogOut className="size-4" /> Sign out
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] bg-bg/70 px-6 py-2.5 backdrop-blur">
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            <span className="flex items-center gap-1.5">
              <span className={cx("size-2 rounded-full", online === vms.length && vms.length ? "bg-[var(--good)]" : online ? "bg-[var(--warning)]" : "bg-zinc-600")} />
              <span className="tabular-nums">
                {online}/{vms.length}
              </span>{" "}
              online
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400 select-none">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--accent)]" />
              Auto-refresh 30s
            </label>
            <button
              onClick={() => refresh()}
              className="flex items-center gap-1.5 rounded-md border border-[var(--line-strong)] px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              <RefreshCw className={cx("size-3.5", anyChecking && "animate-spin")} />
              Refresh
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}


/** Reading the URL makes dynamic routes (e.g. /projects/[name]) suspend, so the nav lives in its own boundary. */
function NavWithPath() {
  return <Nav path={usePathname()} />;
}

function Nav({ path }: { path: string | null }) {
  return (
      <>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = path !== null && (href === "/" ? path === "/" : path.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={cx(
                "flex shrink-0 items-center gap-2.5 rounded-full px-3 py-1.5 text-sm transition-colors",
                active ? "bg-white text-[#0b0e1c] font-medium" : "text-muted hover:bg-white/5 hover:text-zinc-100",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </>
  );
}
