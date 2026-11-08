"use client";

import {
  Activity,
  Archive,
  BarChart3,
  Bot,
  Boxes,
  Code2,
  Container,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Leaf,
  LineChart,
  Loader2,
  Lock,
  Plus,
  Settings2,
  Table2,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/chat-blocks";
import { useCluster } from "@/components/cluster";
import { DatabasesSection } from "@/components/databases-section";
import { Drawer } from "@/components/drawer";
import { PageHero } from "@/components/page-hero";
import { Badge, Button, Card, Field, cx, inputCls } from "@/components/ui";
import { CATALOG, CATEGORIES, engineFromStart, template, type ServiceCategory, type ServiceTemplate } from "@/lib/catalog";
import { api } from "@/lib/client";
import { rankMachines } from "@/lib/placement";
import type { ProjectManifest, ProjectState } from "@/lib/types";

const ICON: Record<string, LucideIcon> = {
  postgres: Database,
  mysql: Database,
  mariadb: Database,
  mongodb: Leaf,
  redis: Zap,
  pgadmin: Table2,
  phpmyadmin: Table2,
  adminer: Table2,
  "mongo-express": Table2,
  redisinsight: Table2,
  cloudbeaver: Table2,
  minio: Archive,
  "uptime-kuma": Activity,
  grafana: LineChart,
  n8n: Workflow,
  metabase: BarChart3,
  ollama: Bot,
  "code-server": Code2,
  portainer: Container,
};

const ENGINE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL / MariaDB", mongo: "MongoDB", redis: "Redis" };

interface Running {
  vm: string;
  p: ProjectState;
  t?: ServiceTemplate;
}

export default function ServicesPage() {
  const { vms, status } = useCluster();
  const [cat, setCat] = useState<ServiceCategory | "All">("All");
  const [adding, setAdding] = useState<ServiceTemplate | null>(null);

  // installed tools and apps (everything that isn't a database or your own code)
  const tools = useMemo<Running[]>(
    () =>
      vms.flatMap((v) =>
        (status[v.name]?.agent?.projects ?? [])
          .filter((p) => p.manifest.category === "tool" || (p.manifest.template && template(p.manifest.template)?.type !== "database"))
          .map((p) => ({ vm: v.name, p, t: p.manifest.template ? template(p.manifest.template) : undefined })),
      ),
    [vms, status],
  );
  const shown = CATALOG.filter((t) => cat === "All" || t.category === cat);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 px-10 py-8">
      <PageHero
        eyebrow="Databases, tools, apps"
        title="Services"
        icon={<Boxes className="size-6" />}
        desc="Everything that isn't your own code. Add one in a click: it goes on the right machine, gets strong passwords, and database tools come already pointed at your databases."
        actions={
          <Button variant="primary" onClick={() => document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth" })}>
            <Plus className="size-4" /> Add a service
          </Button>
        }
      />

      <Section title="Databases" hint="Private on 127.0.0.1. These are the real passwords (random and strong), ready to copy.">
        <DatabasesSection />
      </Section>

      <Section title="Tools & apps" hint="Admin tools and ready-made apps, with their link and sign-in.">
        {tools.length === 0 ? (
          <Card className="p-6 text-sm text-muted">Nothing yet. pgAdmin, phpMyAdmin, Uptime Kuma, n8n and more are one click away below.</Card>
        ) : (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
            {tools.map((x) => (
              <ToolCard key={`${x.vm}-${x.p.manifest.name}`} x={x} />
            ))}
          </div>
        )}
      </Section>

      <section id="catalog" className="scroll-mt-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-[15px] font-semibold text-white">Add a service</h2>
          {(["All", ...CATEGORIES] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={cx("rounded-full border px-3 py-1 text-xs transition-colors", cat === c ? "border-white bg-white font-medium text-[#0b0e1c]" : "border-line-strong text-ink hover:border-white/30")}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {shown.map((t) => {
            const Icon = ICON[t.id] ?? Boxes;
            return (
              <Card key={t.id} className="flex flex-col p-4 transition-colors hover:border-white/15">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line-strong bg-chip text-ink">
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-white">{t.name}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{t.desc}</p>
                  </div>
                </div>
                <div className="mt-auto flex items-center gap-1.5 pt-4">
                  <Badge>{t.category}</Badge>
                  {t.connects && <Badge tone="blue">for {t.connects.engines.length > 1 ? "SQL databases" : ENGINE_LABEL[t.connects.engines[0]]}</Badge>}
                  {t.ram && <span className="text-[11px] text-muted">needs ~{t.ram}</span>}
                  <span className="flex-1" />
                  <Button size="sm" onClick={() => setAdding(t)}>
                    <Plus className="size-3.5" /> Add
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {adding && <AddService t={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-[15px] font-semibold text-white">{title}</h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** An installed tool: status, link, how to sign in. */
function ToolCard({ x }: { x: Running }) {
  const m: ProjectManifest = x.p.manifest;
  const Icon = (x.t && ICON[x.t.id]) || Settings2;
  const login = x.t?.login;
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (env) return env;
    setLoading(true);
    try {
      const r = await api<{ env: { key: string; value: string }[] }>("/api/projects/action", { vm: x.vm, name: m.name, action: "env" });
      const e = Object.fromEntries(r.env.map((v) => [v.key, v.value]));
      setEnv(e);
      return e;
    } finally {
      setLoading(false);
    }
  };
  const user = login?.user ?? (login?.userEnv ? env?.[login.userEnv] : undefined);
  const pass = login?.passEnv ? env?.[login.passEnv] : undefined;
  const ok = x.p.active === "active";

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line-strong bg-chip text-ink">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={`/projects/${m.name}`} className="block truncate font-semibold text-white hover:underline">
            {m.name}
          </Link>
          <p className="truncate text-xs text-muted">
            {m.framework ?? x.t?.name ?? "Tool"} · <span className="font-mono">{x.vm}</span>
            {m.uses?.length ? ` · uses ${m.uses.map((u) => u.name).join(", ")}` : ""}
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-ink">
          <span className={cx("size-1.5 rounded-full", ok ? "bg-accent" : x.p.active === "failed" ? "bg-[var(--critical)]" : "bg-[var(--others)]")} />
          {ok ? "Running" : x.p.active}
        </span>
      </div>

      {x.p.url ? (
        <div className="mt-3 flex items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1.5">
          {x.p.url.includes("_token=") && <Lock className="size-3.5 shrink-0 text-muted" />}
          <a href={x.p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-accent-soft hover:underline">
            Open {x.t?.name ?? m.name}
          </a>
          <a href={x.p.url} target="_blank" rel="noreferrer" className="p-1 text-muted hover:text-white" title="Open">
            <ExternalLink className="size-3.5" />
          </a>
          <CopyButton text={x.p.url} />
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">No link{m.port ? ` · port ${m.port}` : ""}</p>
      )}

      {login && (login.user || login.userEnv || login.passEnv) ? (
        <div className="mt-3 grid grid-cols-[72px_minmax(0,1fr)] items-center gap-y-1.5 text-xs">
          {(login.user || login.userEnv) && (
            <>
              <span className="text-muted">User</span>
              <span className="flex items-center gap-1 font-mono text-ink">
                {user ?? (login.userEnv ? "•••" : "")}
                {user && <CopyButton text={user} />}
              </span>
            </>
          )}
          {login.passEnv && (
            <>
              <span className="text-muted">Password</span>
              <span className="flex min-w-0 items-center gap-1 font-mono text-ink">
                <span className="truncate">{show && pass !== undefined ? pass || "(none)" : "••••••••••••"}</span>
                <button
                  onClick={async () => {
                    await load();
                    setShow((s) => !s);
                  }}
                  className="p-0.5 text-muted hover:text-white"
                  aria-label={show ? "Hide password" : "Show password"}
                >
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
                {pass !== undefined ? (
                  <CopyButton text={pass} />
                ) : (
                  <button onClick={() => void load()} className="text-[11px] text-muted hover:text-white">
                    load
                  </button>
                )}
              </span>
            </>
          )}
        </div>
      ) : null}
      {login?.note && <p className="mt-2 text-[11px] text-muted">{login.note}</p>}
    </Card>
  );
}

function AddService({ t, onClose }: { t: ServiceTemplate; onClose: () => void }) {
  const { vms, status, openJob, refresh } = useCluster();
  const [name, setName] = useState("");
  const [vm, setVm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; vm: string; notes: string[] } | null>(null);

  const dbs = useMemo(
    () =>
      t.connects
        ? vms.flatMap((v) =>
            (status[v.name]?.agent?.projects ?? [])
              .filter((p) => p.manifest.category === "database" && t.connects!.engines.includes(engineFromStart(p.manifest.start) as never))
              .map((p) => ({ name: p.manifest.name, vm: v.name })),
          )
        : [],
    [t, vms, status],
  );
  const [target, setTarget] = useState(dbs[0]?.name ?? "");
  const auto = target ? dbs.find((d) => d.name === target)?.vm : rankMachines(vms.map((v) => v.name), status, t.type === "database" ? "database" : t.type === "tool" ? "tool" : "service", "box5")[0];

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ name: string; vm: string; jobId: string; notes: string[] }>("/api/services", { template: t.id, name: name || undefined, vm: vm || undefined, connectTo: target || undefined });
      setResult(r);
      openJob({ vm: r.vm, id: r.jobId, title: `deploy ${r.name}` });
      void refresh([r.vm]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const Icon = ICON[t.id] ?? Boxes;
  return (
    <Drawer title={`Add ${t.name}`} subtitle={t.desc} onClose={onClose}>
      {result ? (
        <div className="space-y-3">
          <p className="text-lg font-semibold text-white">
            {result.name} is being set up on {result.vm}
          </p>
          <ul className="space-y-1 text-sm text-ink">
            {result.notes.map((n) => (
              <li key={n}>• {n}</li>
            ))}
            <li>• Its link and sign-in appear under Tools & apps (or Databases) when the deploy finishes.</li>
          </ul>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-line-strong p-3">
            <span className="grid size-10 place-items-center rounded-xl bg-chip text-ink">
              <Icon className="size-5" />
            </span>
            <div className="text-sm">
              <p className="text-white">
                {t.category} · port {t.port} · {t.link === "none" ? "no link (private)" : t.link === "private" ? "private link with a secret token" : "public link"}
              </p>
              <p className="text-xs text-muted">Docker container, data kept in ~/data/{name || t.id}{t.ram ? `, needs about ${t.ram} of memory` : ""}</p>
            </div>
          </div>
          <Field label="Name" hint={`Defaults to ${t.id} (or ${t.id}-2 if taken)`}>
            <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder={t.id} className={inputCls} />
          </Field>
          {t.connects && (
            <Field label="Connect to" hint={dbs.length ? "Its settings are filled in and it runs next to the database." : "No matching database yet: add one first, or connect it later on the Pipeline."}>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls}>
                {dbs.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name} on {d.vm}
                  </option>
                ))}
                <option value="">Don&apos;t connect now</option>
              </select>
            </Field>
          )}
          <Field label="Machine">
            <select value={vm} onChange={(e) => setVm(e.target.value)} className={inputCls}>
              <option value="">Auto{auto ? ` (${auto})` : ""}</option>
              {vms.map((v) => (
                <option key={v.name} value={v.name} disabled={!status[v.name]?.ok}>
                  {v.name}
                  {status[v.name]?.ok ? "" : " (unreachable)"}
                </option>
              ))}
            </select>
          </Field>
          {error && <p className="text-sm text-[var(--critical-text)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={add} loading={busy}>
              <Plus className="size-4" /> Add {t.name}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
