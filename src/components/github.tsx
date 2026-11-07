"use client";

import { Check, ExternalLink, Lock, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import { Button, Field, cx, inputCls } from "./ui";

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={cx("size-4 shrink-0", className)}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export interface GithubStatus {
  connected: boolean;
  login?: string;
  source?: "env" | "dashboard";
  scopes?: string[];
  missing?: string[];
}

// One request per page load, shared by every component that asks.
let statusPromise: Promise<GithubStatus> | null = null;
const listeners = new Set<(s: GithubStatus) => void>();

function loadStatus(fresh = false): Promise<GithubStatus> {
  if (!statusPromise || fresh) {
    statusPromise = api<GithubStatus>(`/api/github${fresh ? "?fresh=1" : ""}`).catch(() => ({ connected: false }));
    void statusPromise.then((s) => listeners.forEach((l) => l(s)));
  }
  return statusPromise;
}

export function useGithub(): { status: GithubStatus | null; reload: () => Promise<GithubStatus>; set: (s: GithubStatus) => void } {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  useEffect(() => {
    listeners.add(setStatus);
    void loadStatus().then(setStatus);
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  const reload = useCallback(() => loadStatus(true), []);
  const set = useCallback((s: GithubStatus) => {
    statusPromise = Promise.resolve(s);
    listeners.forEach((l) => l(s));
  }, []);
  return { status, reload, set };
}

const TOKEN_URL = "https://github.com/settings/tokens/new?description=Hosting%20dashboard&scopes=repo,admin:repo_hook";

/** Connect or disconnect. Paste-a-token: no OAuth app to register, works the moment it's saved. */
export function GithubConnect({ onDone }: { onDone?: (s: GithubStatus) => void }) {
  const { status, set } = useGithub();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api<GithubStatus>("/api/github", { token });
      set(s);
      setToken("");
      onDone?.(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!confirm("Disconnect GitHub? Auto-deploy and private repo deploys stop until you connect again.")) return;
    setBusy(true);
    try {
      set(await api<GithubStatus>("/api/github", { disconnect: true }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (status?.connected)
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-line-strong p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`https://github.com/${status.login}.png?size=80`} alt="" className="size-10 rounded-full bg-chip" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 font-medium text-white">
              <Check className="size-4 text-accent-soft" /> Connected as @{status.login}
            </p>
            <p className="text-xs text-muted">{status.source === "env" ? "Through the GITHUB_TOKEN env var" : "Token saved encrypted on the storage machine"}</p>
          </div>
          {status.source === "dashboard" && (
            <Button size="sm" variant="ghost" onClick={disconnect} loading={busy}>
              Disconnect
            </Button>
          )}
        </div>
        {status.missing?.length ? (
          <p className="text-sm text-[var(--critical-text)]">
            This token is missing {status.missing.join(" and ")}. Import works, but auto-deploy webhooks can&apos;t be added.{" "}
            <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="underline">
              Make a new one
            </a>
            .
          </p>
        ) : (
          <p className="text-sm text-muted">Import a repo from New project. Pushes to its branch redeploy it on every machine that runs it.</p>
        )}
        {error && <p className="text-sm text-[var(--critical-text)]">{error}</p>}
      </div>
    );

  return (
    <div className="space-y-4">
      <ol className="space-y-3 text-sm text-ink">
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-chip text-xs font-semibold">1</span>
          <div>
            <p>Create a token on GitHub. The link fills in the name and the two permissions it needs:</p>
            <p className="mt-1 text-xs text-muted">
              <code>repo</code> to read your repos (private too), <code>admin:repo_hook</code> to add the push webhook.
            </p>
            <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line-strong px-3 py-1.5 text-sm text-white hover:border-accent/60">
              <GithubMark /> Create token on GitHub <ExternalLink className="size-3.5 text-muted" />
            </a>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-chip text-xs font-semibold">2</span>
          <div className="min-w-0 flex-1">
            <p>Paste it here. It&apos;s checked with GitHub, then kept encrypted; the browser never sees it again.</p>
            <Field label="">
              <input
                value={token}
                onChange={(e) => setToken(e.target.value.trim())}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="ghp_…"
                className={cx(inputCls, "mt-2 font-mono")}
                onKeyDown={(e) => e.key === "Enter" && token && void connect()}
              />
            </Field>
          </div>
        </li>
      </ol>
      {error && <p className="text-sm text-[var(--critical-text)]">{error}</p>}
      <div className="flex justify-end">
        <Button variant="primary" onClick={connect} loading={busy} disabled={token.length < 20}>
          <GithubMark /> Connect GitHub
        </Button>
      </div>
    </div>
  );
}

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
  url: string;
}

let reposPromise: Promise<Repo[]> | null = null;

/** Vercel-style "Import Git Repository" list. */
export function RepoPicker({ onPick, busyRepo, limit = 6 }: { onPick: (r: Repo) => void; busyRepo?: string | null; limit?: number }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!reposPromise) reposPromise = api<{ repos: Repo[] }>("/api/github/repos").then((r) => r.repos);
    reposPromise.then(
      (r) => {
        setRepos(r);
        setNow(Date.now());
      },
      (e: Error) => {
        reposPromise = null;
        setError(e.message);
      },
    );
  }, []);

  const shown = useMemo(() => {
    const t = q.toLowerCase();
    return (repos ?? []).filter((r) => !t || r.fullName.toLowerCase().includes(t)).slice(0, t ? 30 : limit);
  }, [repos, q, limit]);

  return (
    <div className="overflow-hidden rounded-xl border border-line-strong">
      <div className="flex items-center gap-2 border-b border-line-strong px-3 py-2">
        <Search className="size-4 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search repositories…" className="w-full bg-transparent text-sm text-white outline-none placeholder:text-muted" />
      </div>
      {error ? (
        <p className="p-4 text-sm text-[var(--critical-text)]">{error}</p>
      ) : !repos ? (
        <ul className="divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-3">
              <span className="h-3.5 w-48 animate-pulse rounded bg-chip" />
            </li>
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <p className="p-4 text-sm text-muted">No repositories match.</p>
      ) : (
        <ul className="max-h-[340px] divide-y divide-line overflow-y-auto">
          {shown.map((r) => (
            <li key={r.fullName} className="flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.02]">
              <GithubMark className="text-muted" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm text-white">
                  <span className="truncate">{r.fullName}</span>
                  {r.private && <Lock className="size-3 shrink-0 text-muted" />}
                </p>
                <p className="truncate text-xs text-muted">
                  {[r.language, r.pushedAt && now ? `pushed ${timeAgo(Date.parse(r.pushedAt), now)}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <Button size="sm" onClick={() => onPick(r)} loading={busyRepo === r.fullName} disabled={Boolean(busyRepo)}>
                Import
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
