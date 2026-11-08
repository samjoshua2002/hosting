"use client";

import { Bell, ChevronLeft, ChevronRight, LogOut, Plus, RefreshCw, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { serviceIdOf } from "@/lib/catalog";
import { api } from "@/lib/client";
import { findProblems } from "@/lib/health";
import { useAssistantBusy } from "./assistant-store";
import { useCluster } from "./cluster";
import { CommandPalette } from "./command-palette";
import { crumbs, NAV } from "./nav";
import { cx } from "./ui";

export function Shell({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState(false);

  // ⌘K / Ctrl+K anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-dvh flex-row">
      <aside className="sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--sidebar)] px-3 py-4">
        <Link href="/" className="mb-5 flex items-center gap-2.5 px-2">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-ink)]">
            <span className="size-2.5 rounded-sm bg-[var(--accent-ink)]" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-white">hosting</span>
        </Link>
        <button
          onClick={() => setPalette(true)}
          className="mb-5 flex h-9 items-center gap-2 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 text-sm text-muted hover:border-white/20"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-[var(--line-strong)] px-1 font-sans text-[10px]">⌘K</kbd>
        </button>
        <Suspense fallback={<Nav path={null} />}>
          <NavWithPath />
        </Suspense>
        <div className="flex-1" />
        <AutopilotCard />
        <SignOut />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<TopBar path={null} />}>
          <TopBarWithPath />
        </Suspense>
        <main className="relative isolate min-w-0 flex-1">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

/** Reading the URL makes dynamic routes (e.g. /projects/[name]) suspend, so these live in their own boundaries. */
function NavWithPath() {
  return <Nav path={usePathname()} />;
}
function TopBarWithPath() {
  return <TopBar path={usePathname()} />;
}

function Nav({ path }: { path: string | null }) {
  const working = useAssistantBusy();
  const { vms, status } = useCluster();
  const counts = useMemo(() => {
    const names = new Map<string, boolean>();
    for (const v of vms) for (const p of status[v.name]?.agent?.projects ?? []) names.set(p.manifest.name, Boolean(serviceIdOf(p.manifest)));
    const services = [...names.values()].filter(Boolean).length;
    return { "/projects": names.size - services, "/services": services, "/machines": vms.length } as Record<string, number>;
  }, [vms, status]);

  return (
    <nav className="space-y-5">
      {NAV.map((g) => (
        <div key={g.title}>
          <p className="mb-1.5 px-3 text-[10.5px] font-semibold tracking-[0.12em] text-muted/80 uppercase">{g.title}</p>
          <div className="space-y-0.5">
            {g.items.map(({ href, label, icon: Icon }) => {
              const active = path !== null && (href === "/" ? path === "/" : path.startsWith(href));
              return (
                <Link
                  key={href}
                  href={href}
                  className={cx(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    active ? "bg-white/[0.08] font-medium text-white" : "text-zinc-400 hover:bg-white/[0.04] hover:text-white",
                  )}
                >
                  <Icon className={cx("size-[18px]", active ? "text-[var(--accent)]" : "text-zinc-500")} />
                  <span className="flex-1">{label}</span>
                  {href === "/assistant" && working && <span className="size-2 animate-pulse rounded-full bg-[var(--accent)]" title="The Assistant is working" />}
                  {counts[href] ? <span className="rounded-md bg-white/[0.06] px-1.5 text-[11px] tabular-nums text-zinc-400">{counts[href]}</span> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function TopBar({ path }: { path: string | null }) {
  const router = useRouter();
  const { vms, status, checking, refresh, auto, setAuto } = useCluster();
  const online = vms.filter((v) => status[v.name]?.ok).length;
  const anyChecking = Object.values(checking).some(Boolean);
  const problems = useMemo(() => findProblems(vms.filter((v) => status[v.name] && !checking[v.name]).map((v) => status[v.name]!)), [vms, status, checking]);
  const trail = crumbs(path);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg)]/90 px-6 backdrop-blur">
      <div className="flex items-center gap-1">
        <button onClick={() => router.back()} className="grid size-8 place-items-center rounded-lg border border-[var(--line)] text-zinc-400 hover:text-white" aria-label="Back">
          <ChevronLeft className="size-4" />
        </button>
        <button onClick={() => router.forward()} className="grid size-8 place-items-center rounded-lg border border-[var(--line)] text-zinc-400 hover:text-white" aria-label="Forward">
          <ChevronRight className="size-4" />
        </button>
      </div>
      <nav className="flex min-w-0 items-center gap-1.5 text-sm">
        <Link href="/" className="text-muted hover:text-white">
          hosting
        </Link>
        {trail.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1.5">
            <ChevronRight className="size-3.5 text-zinc-600" />
            <span className={cx("truncate", i === trail.length - 1 ? "text-white" : "text-muted")}>{c}</span>
          </span>
        ))}
      </nav>
      <span className="flex-1" />
      <span className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs text-zinc-300">
        <span className={cx("size-2 rounded-full", online === vms.length && vms.length ? "bg-[var(--good)]" : online ? "bg-[var(--warning)]" : "bg-zinc-600")} />
        <span className="tabular-nums">
          {online}/{vms.length}
        </span>
        online
      </span>
      <button
        onClick={() => setAuto(!auto)}
        className={cx("rounded-lg border px-2.5 py-1 text-xs", auto ? "border-[var(--line)] text-zinc-300" : "border-[var(--line)] text-muted line-through")}
        title={auto ? "Refreshing every 30 s (click to pause)" : "Auto-refresh paused (click to resume)"}
      >
        Live
      </button>
      <button onClick={() => refresh()} className="grid size-8 place-items-center rounded-lg border border-[var(--line)] hover:bg-white/5" aria-label="Refresh" title="Refresh now">
        <RefreshCw className={cx("size-4 text-[var(--accent)]", anyChecking && "animate-spin")} />
      </button>
      <Link href="/" className="relative grid size-8 place-items-center rounded-lg border border-[var(--line)] hover:bg-white/5" aria-label="Alerts" title={problems.length ? `${problems.length} need attention` : "No alerts"}>
        <Bell className="size-4 text-[var(--accent)]" />
        {problems.length > 0 && <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-[var(--critical)] text-[9px] font-bold text-white">{problems.length}</span>}
      </Link>
      <Link href="/projects?new=1" className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-sm font-medium text-[var(--accent-ink)] hover:brightness-110">
        <Plus className="size-4" /> Deploy
      </Link>
    </header>
  );
}

/** Bottom of the sidebar, like the reference's upgrade card: Autopilot at a glance. */
function AutopilotCard() {
  const [s, setS] = useState<{ enabled: boolean; lastSummary?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ enabled: boolean; lastSummary?: string }>("/api/autopilot").then((r) => alive && setS(r), () => {});
    void load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!s) return null;
  return (
    <div className="mb-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-white">
        <ShieldCheck className="size-4 text-[var(--accent)]" /> Autopilot {s.enabled ? "on" : "off"}
      </p>
      <p className="mt-1 line-clamp-2 text-xs text-muted">
        {s.enabled ? (s.lastSummary?.split("\n")[0] ?? "Watching your machines every 15 minutes.") : "Let it restart crashes and fix problems every 15 minutes."}
      </p>
      <Link href="/assistant" className="mt-2.5 inline-flex h-7 items-center rounded-lg bg-[var(--accent)] px-2.5 text-xs font-medium text-[var(--accent-ink)] hover:brightness-110">
        {s.enabled ? "Open Assistant" : "Turn on"}
      </Link>
    </div>
  );
}

function SignOut() {
  const logout = async () => {
    await api("/api/auth/logout", {}).catch(() => {});
    window.location.href = "/login";
  };
  return (
    <button onClick={logout} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/[0.04] hover:text-white">
      <LogOut className="size-[18px] text-zinc-500" /> Log out
    </button>
  );
}
