"use client";

import { Bell, LogOut, Plus, RefreshCw, Search, ShieldCheck, Shuffle } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isService } from "@/lib/catalog";
import { api } from "@/lib/client";
import { findProblems, investigatePrompt } from "@/lib/health";
import type { MailItem } from "@/lib/mail";
import { startChat, useAssistantBusy } from "./assistant-store";
import { useCluster } from "./cluster";
import { CommandPalette } from "./command-palette";
import { StorageBanner } from "./storage-banner";
import { crumbs, NAV } from "./nav";
import { shuffleTheme, UnsplashLayer, useTheme } from "./theme";
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
      <Suspense fallback={<Sidebar path={null} onSearch={() => setPalette(true)} />}>
        <SidebarWithPath onSearch={() => setPalette(true)} />
      </Suspense>

      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<TopBar path={null} />}>
          <TopBarWithPath />
        </Suspense>
        <StorageBanner />
        <main className="relative isolate min-w-0 flex-1">
          <Suspense fallback={null}>
            <Cover />
          </Suspense>
          {children}
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

function SidebarWithPath({ onSearch }: { onSearch: () => void }) {
  return <Sidebar path={usePathname()} onSearch={onSearch} />;
}

/** The main menu. On the Assistant it folds into an icon rail so the conversation gets the room. */
function Sidebar({ path, onSearch }: { path: string | null; onSearch: () => void }) {
  const compact = Boolean(path?.startsWith("/assistant"));
  return (
    <aside className={cx("sticky top-0 flex h-dvh shrink-0 flex-col border-r border-white/[0.05] bg-[var(--sidebar)] py-3 transition-[width] duration-200", compact ? "w-[60px] items-center px-2" : "w-56 px-2.5")}>
      <Link href="/" className={cx("mb-3 flex h-9 items-center gap-2", compact ? "justify-center" : "px-2")} title="hosting">
        <span className="grid size-6 place-items-center rounded-md bg-white text-black">
          <span className="size-2 rounded-[3px] bg-black" />
        </span>
        {!compact && <span className="text-sm font-semibold tracking-tight text-white">hosting</span>}
      </Link>
      {compact ? (
        <button onClick={onSearch} className="mb-4 grid size-9 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200" title="Search (⌘K)" aria-label="Search">
          <Search className="size-4" />
        </button>
      ) : (
        <button
          onClick={onSearch}
          className="mb-4 flex h-8 items-center gap-2 rounded-md bg-white/[0.04] px-2.5 text-[13px] text-zinc-500 transition-colors hover:bg-white/[0.07] hover:text-zinc-300"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search</span>
          <span className="text-[11px] text-zinc-600">⌘K</span>
        </button>
      )}
      <Nav path={path} compact={compact} />
      <div className="flex-1" />
      <AutopilotCard compact={compact} />
      <SignOut compact={compact} />
    </aside>
  );
}

/** Reading the URL makes dynamic routes (e.g. /projects/[name]) suspend, so these live in their own boundaries. */
/** The day's Unsplash photo as a full-width cover fading into the top of each page (not behind the Assistant's columns). */
function Cover() {
  const path = usePathname();
  const { photo } = useTheme();
  if (path?.startsWith("/assistant") || path?.startsWith("/settings")) return null;
  return <UnsplashLayer photo={photo} className="page-cover" />;
}

function TopBarWithPath() {
  return <TopBar path={usePathname()} />;
}

function Nav({ path, compact }: { path: string | null; compact?: boolean }) {
  const working = useAssistantBusy();
  const { vms, status } = useCluster();
  const counts = useMemo(() => {
    const names = new Map<string, boolean>();
    for (const v of vms) for (const p of status[v.name]?.agent?.projects ?? []) names.set(p.manifest.name, isService(p.manifest));
    const services = [...names.values()].filter(Boolean).length;
    return { "/projects": names.size - services, "/services": services, "/machines": vms.length } as Record<string, number>;
  }, [vms, status]);

  return (
    <nav className={cx(compact ? "space-y-3" : "space-y-4")}>
      {NAV.map((g) => (
        <div key={g.title} className={cx(compact && "border-t border-white/[0.05] pt-3 first:border-0 first:pt-0")}>
          {!compact && <p className="mb-1 px-2.5 text-[11px] font-medium text-zinc-600">{g.title}</p>}
          <div className={cx(compact ? "space-y-1" : "space-y-px")}>
            {g.items.map(({ href, label, icon: Icon }) => {
              const active = path !== null && (href === "/" ? path === "/" : path.startsWith(href));
              return (
                <Link
                  key={href}
                  href={href}
                  title={compact ? `${label}${counts[href] ? ` (${counts[href]})` : ""}` : undefined}
                  aria-label={compact ? label : undefined}
                  className={cx(
                    "relative flex items-center rounded-md text-[13px] transition-colors",
                    compact ? "size-9 justify-center" : "h-8 gap-2.5 px-2.5",
                    active ? "bg-white/[0.07] text-white" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100",
                  )}
                >
                  <Icon className={cx("size-4", active ? "text-[var(--accent)]" : "text-zinc-500")} strokeWidth={1.75} />
                  {!compact && <span className="flex-1">{label}</span>}
                  {href === "/assistant" && working && <span className={cx("size-2 animate-pulse rounded-full bg-[var(--accent)]", compact && "absolute top-1 right-1 size-1.5")} title="The Assistant is working" />}
                  {!compact && counts[href] ? <span className="text-[11px] tabular-nums text-zinc-600">{counts[href]}</span> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="grid size-8 place-items-center rounded-md text-zinc-400 hover:bg-white/[0.05] hover:text-white" aria-label={label} title={label}>
      {children}
    </button>
  );
}

function TopBar({ path }: { path: string | null }) {
  const { vms, status, checking, refresh, auto, setAuto } = useCluster();
  const { photo } = useTheme();
  const [shuffling, setShuffling] = useState(false);
  const online = vms.filter((v) => status[v.name]?.ok).length;
  const anyChecking = Object.values(checking).some(Boolean);
  const problems = useMemo(() => findProblems(vms.filter((v) => status[v.name] && !checking[v.name]).map((v) => status[v.name]!)), [vms, status, checking]);
  const trail = crumbs(path);

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center gap-1 border-b border-white/[0.05] bg-[var(--bg)]/80 px-5 backdrop-blur-md">
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {trail.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <span className="text-zinc-700">/</span>}
            <span className={cx("truncate", i === trail.length - 1 ? "text-white" : "text-zinc-500")}>{c}</span>
          </span>
        ))}
      </nav>
      <span className="flex-1" />
      <button
        onClick={() => setAuto(!auto)}
        role="switch"
        aria-checked={auto}
        className="mr-2 flex items-center gap-2 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-white"
        title={auto ? "Live: refreshing every 30 s (click to pause)" : "Paused (click to resume)"}
      >
        <span className={cx("size-1.5 rounded-full", online === vms.length && vms.length ? "bg-[var(--good)]" : online ? "bg-[var(--warning)]" : "bg-zinc-600", auto && "animate-pulse-dot")} />
        <span className="tabular-nums">
          {online}/{vms.length} online
        </span>
        {!auto && <span className="text-zinc-600">· paused</span>}
      </button>
      <IconButton label="Refresh now" onClick={() => refresh()}>
        <RefreshCw className={cx("size-4", anyChecking && "animate-spin")} />
      </IconButton>
      <IconButton
        label={photo ? `New photo and accent (now: ${photo.author} on Unsplash)` : "New photo and accent"}
        onClick={async () => {
          setShuffling(true);
          try {
            await shuffleTheme();
          } finally {
            setShuffling(false);
          }
        }}
      >
        <Shuffle className={cx("size-4", shuffling && "animate-spin")} />
      </IconButton>
      <Alerts problems={problems} />
      <Link href="/projects?new=1" className="ml-2 flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[13px] font-medium text-black hover:bg-white/90">
        <Plus className="size-3.5" /> Deploy
      </Link>
    </header>
  );
}

/** The bell: what needs attention right now, each one a click away from the Assistant looking into it. */
function Alerts({ problems }: { problems: MailItem[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const ask = (list: MailItem[]) => {
    startChat(investigatePrompt(list), `Investigate: ${list.map((p) => p.title).join(", ")}`);
    setOpen(false);
    router.push("/assistant");
  };
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx("relative grid size-8 place-items-center rounded-md text-zinc-400 hover:bg-white/[0.05] hover:text-white", open && "bg-white/[0.06] text-white")}
        aria-label="Alerts"
        aria-expanded={open}
        title={problems.length ? `${problems.length} need attention` : "No alerts"}
      >
        <Bell className="size-4" />
        {problems.length > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-[var(--critical)] ring-2 ring-[var(--bg)]" />}
      </button>
      {open && (
        <div className="absolute top-10 right-0 z-40 w-[380px] overflow-hidden rounded-xl border border-white/[0.08] bg-[var(--panel)] shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
            <p className="text-[13px] font-medium text-white">{problems.length ? `${problems.length} need${problems.length === 1 ? "s" : ""} attention` : "Alerts"}</p>
            {problems.length > 1 && (
              <button onClick={() => ask(problems)} className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-ink)] hover:brightness-110">
                Investigate all
              </button>
            )}
          </div>
          {problems.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-zinc-500">All clear. Every machine and project looks healthy.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-white/[0.05] overflow-y-auto">
              {problems.map((p) => (
                <li key={p.title} className="flex items-start gap-3 px-4 py-3">
                  <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", p.tone === "critical" ? "bg-[var(--critical)]" : "bg-[var(--warning)]")} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-white">{p.title}</p>
                    {p.detail && <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{p.detail}</p>}
                  </div>
                  <button onClick={() => ask([p])} className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-300 ring-1 ring-white/10 hover:bg-white/[0.06] hover:text-white">
                    Ask
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Bottom of the sidebar, like the reference's upgrade card: Autopilot at a glance. */
function AutopilotCard({ compact }: { compact?: boolean }) {
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
  if (compact)
    return (
      <Link href="/settings?tab=autopilot" className="relative mb-1 grid size-9 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-100" title={`Autopilot ${s.enabled ? "on" : "off"}`} aria-label="Autopilot">
        <ShieldCheck className="size-4" strokeWidth={1.75} />
        <span className={cx("absolute top-1.5 right-1.5 size-1.5 rounded-full", s.enabled ? "bg-[var(--good)]" : "bg-zinc-600")} />
      </Link>
    );
  return (
    <Link href="/settings?tab=autopilot" className="mb-1 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100" title={s.lastSummary ?? undefined}>
      <ShieldCheck className="size-4 text-zinc-500" strokeWidth={1.75} />
      <span className="flex-1">Autopilot</span>
      <span className={cx("size-1.5 rounded-full", s.enabled ? "bg-[var(--good)]" : "bg-zinc-600")} />
      <span className="text-[11px] text-zinc-600">{s.enabled ? "on" : "off"}</span>
    </Link>
  );
}

function SignOut({ compact }: { compact?: boolean }) {
  const logout = async () => {
    await api("/api/auth/logout", {}).catch(() => {});
    window.location.href = "/login";
  };
  if (compact)
    return (
      <button onClick={logout} className="grid size-9 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-100" title="Log out" aria-label="Log out">
        <LogOut className="size-4" strokeWidth={1.75} />
      </button>
    );
  return (
    <button onClick={logout} className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100">
      <LogOut className="size-4 text-zinc-500" strokeWidth={1.75} /> Log out
    </button>
  );
}
