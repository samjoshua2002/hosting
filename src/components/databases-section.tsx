"use client";

import { Check, Copy, Database, Eye, EyeOff, Link2, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useCluster } from "./cluster";
import { Badge, Button, Card, Empty, StatusDot, cx, serviceTone } from "./ui";
import { api } from "@/lib/client";
import { vmState } from "@/lib/format";
import type { ProjectState } from "@/lib/types";

type Engine = "postgres" | "mysql" | "mongodb" | "redis" | "other";

const ENGINE: Record<Engine, { label: string; user: string; url: (pw: string, port: number) => string }> = {
  postgres: { label: "PostgreSQL", user: "postgres", url: (pw, p) => `postgresql://postgres:${pw}@127.0.0.1:${p}/postgres` },
  mysql: { label: "MySQL", user: "root", url: (pw, p) => `mysql://root:${pw}@127.0.0.1:${p}/mysql` },
  mongodb: { label: "MongoDB", user: "admin", url: (pw, p) => `mongodb://admin:${pw}@127.0.0.1:${p}/?authSource=admin` },
  redis: { label: "Redis", user: "(none)", url: (pw, p) => `redis://:${pw}@127.0.0.1:${p}` },
  other: { label: "Database", user: "", url: (_pw, p) => `127.0.0.1:${p}` },
};

function engineOf(p: ProjectState): Engine {
  const s = `${p.manifest.start} ${p.manifest.name}`.toLowerCase();
  if (s.includes("postgres")) return "postgres";
  if (s.includes("mysql") || s.includes("mariadb")) return "mysql";
  if (s.includes("mongo")) return "mongodb";
  if (s.includes("redis")) return "redis";
  return "other";
}

interface Db {
  vm: string;
  project: ProjectState;
  engine: Engine;
  port: number;
}

export function DatabasesSection() {
  const { vms, status, checking, refresh } = useCluster();
  const [linking, setLinking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const dbs = useMemo<Db[]>(
    () =>
      vms.flatMap((v) =>
        (status[v.name]?.agent?.projects ?? [])
          .filter((p) => p.manifest.category === "database" && p.manifest.port)
          .map((p) => ({ vm: v.name, project: p, engine: engineOf(p), port: p.manifest.port! })),
      ),
    [vms, status],
  );
  const dbMachines = [...new Set(dbs.map((d) => d.vm))];

  const connectAll = async (db: string) => {
    setLinking(db);
    setMessage(null);
    try {
      const others = vms.map((v) => v.name).filter((n) => n !== db);
      const r = await api<{ results: { vm: string; ok: boolean; error?: string; forwarded?: number[]; skipped?: number[] }[] }>("/api/databases/link", {
        db,
        targets: others,
        link: true,
      });
      setMessage(
        r.results
          .map((x) => (x.ok ? `${x.vm}: ${x.forwarded?.join(", ") || "nothing"}${x.skipped?.length ? ` (skipped ${x.skipped.join(", ")}: already in use)` : ""}` : `${x.vm}: ${x.error}`))
          .join(" · "),
      );
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setLinking(null);
    }
  };

  return (
    <div className="space-y-4">
      {dbs.length === 0 ? (
        <Card>
          <Empty icon={<Database className="size-8" />} title="No databases yet">
            Add PostgreSQL, MySQL, MongoDB or Redis from the catalog below.
          </Empty>
        </Card>
      ) : (
        dbMachines.map((m) => {
          const here = dbs.filter((d) => d.vm === m);
          return (
            <Card key={m} className="overflow-hidden">
              <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-6 py-4">
                <div>
                  <p className="flex items-center gap-2 text-[17px] font-semibold text-white">
                    <StatusDot state={vmState(status[m], Boolean(checking[m]))} />
                    Database machine <span className="font-mono">{m}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">Bound to 127.0.0.1 only: never reachable from the internet.</p>
                </div>
                <Button size="sm" onClick={() => connectAll(m)} loading={linking === m}>
                  <Link2 className="size-3.5" /> Connect all machines
                </Button>
              </div>
              {message && linking === null && <p className="border-b border-white/[0.06] px-6 py-2 text-xs text-muted">{message}</p>}
              <div className="divide-y divide-white/[0.06]">
                {here.map((d) => (
                  <DbRow key={d.project.manifest.name} db={d} />
                ))}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}

function DbRow({ db }: { db: Db }) {
  const { vms, status } = useCluster();
  const e = ENGINE[db.engine];
  const [pw, setPw] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const reveal = async () => {
    if (pw !== null) return setShow((s) => !s);
    setLoading(true);
    try {
      const r = await api<{ env: { key: string; value: string }[] }>("/api/projects/action", { vm: db.vm, name: db.project.manifest.name, action: "env" });
      setPw(r.env.find((x) => /PASSWORD/.test(x.key))?.value ?? "");
      setShow(true);
    } finally {
      setLoading(false);
    }
  };
  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };
  const withPw = async (fn: (p: string) => string, label: string) => {
    let p = pw;
    if (p === null) {
      const r = await api<{ env: { key: string; value: string }[] }>("/api/projects/action", { vm: db.vm, name: db.project.manifest.name, action: "env" });
      p = r.env.find((x) => /PASSWORD/.test(x.key))?.value ?? "";
      setPw(p);
    }
    await copy(label, fn(encodeURIComponent(p)));
  };

  // which machines can reach this database at 127.0.0.1
  const reach = vms.map((v) => {
    if (v.name === db.vm) return { vm: v.name, how: "local" as const };
    const t = status[v.name]?.agent?.tunnels.find((x) => x.to === db.vm && (!x.ports || x.ports.includes(db.port)));
    return { vm: v.name, how: t ? (t.active === "active" ? ("tunnel" as const) : ("down" as const)) : ("none" as const) };
  });
  const masked = "•".repeat(16);

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6 px-6 py-5">
      <div>
        <p className="text-base font-semibold text-white">{e.label}</p>
        <p className="mt-0.5 font-mono text-xs text-muted">
          {db.project.manifest.name} · port {db.port}
        </p>
        <div className="mt-2">
          <Badge tone={serviceTone(db.project.active)}>{db.project.active}</Badge>
        </div>
      </div>
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-y-2">
          <span className="text-muted">Host</span>
          <span className="font-mono text-ink">127.0.0.1:{db.port}</span>
          <span className="text-muted">User</span>
          <span className="font-mono text-ink">{e.user}</span>
          <span className="text-muted">Password</span>
          <span className="flex items-center gap-2 font-mono text-ink">
            {show && pw !== null ? pw || "(none)" : masked}
            <button onClick={reveal} className="text-muted hover:text-white" aria-label={show ? "Hide password" : "Show password"}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <button onClick={() => withPw((p) => decodeURIComponent(p), "pw")} className="text-muted hover:text-white" aria-label="Copy password">
              {copied === "pw" ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
            </button>
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => withPw((p) => e.url(p, db.port), "url")}
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-xs text-ink hover:border-accent/50"
          >
            {copied === "url" ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />} Copy connection string
          </button>
          <button
            onClick={() => copy("ssh", `ssh -N -L ${db.port}:127.0.0.1:${db.port} ${db.vm}`)}
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-xs text-ink hover:border-accent/50"
            title="Run on your laptop, then connect your DB tool to 127.0.0.1"
          >
            {copied === "ssh" ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />} Copy laptop tunnel command
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
          <span className="mr-1 text-muted">Reachable from</span>
          {reach.map((r) => (
            <span
              key={r.vm}
              className={cx(
                "rounded-md px-2 py-0.5 font-mono",
                r.how === "local" || r.how === "tunnel" ? "bg-accent/15 text-ink ring-1 ring-accent/40" : r.how === "down" ? "text-[var(--critical-text)] ring-1 ring-[var(--critical)]/40" : "text-muted ring-1 ring-white/10",
              )}
              title={r.how === "local" ? "same machine" : r.how === "tunnel" ? "through a tunnel" : r.how === "down" ? "tunnel not running" : "not connected"}
            >
              {r.vm}
              {r.how === "local" ? " (here)" : r.how === "down" ? " (down)" : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
