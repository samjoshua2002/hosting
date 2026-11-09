"use client";

import { AlertTriangle, Check, Pencil, Plus, Server, ShieldCheck, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useCluster } from "@/components/cluster";
import { Drawer } from "@/components/drawer";
import { PageHero } from "@/components/page-hero";
import { Button, Card, Field, SectionTitle, StatusDot, cx, inputCls } from "@/components/ui";
import { api } from "@/lib/client";
import { fmtDuration, timeAgo, vmState } from "@/lib/format";

export default function VmsPage() {
  const { vms, status, checking, refresh, reloadVms, configErrors, agentVersion, hostKeyPinned } = useCluster();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("add")) return;
    window.history.replaceState(null, "", "/machines");
    queueMicrotask(() => setAdding(true));
  }, []);

  const rename = async (name: string) => {
    const to = prompt(`New name for ${name} (lowercase letters, digits, dashes):`, name)?.trim().toLowerCase();
    if (!to || to === name) return;
    try {
      await api("/api/machines", { rename: { from: name, to } });
      await reloadVms();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Remove ${name} from the dashboard? Projects on it keep running there but are no longer managed.`)) return;
    setRemoving(name);
    try {
      await api("/api/machines", { remove: name });
      await reloadVms();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
      <PageHero
        eyebrow="Fleet"
        title="Machines"
        icon={<Server className="size-6" />}
        desc="Every machine the dashboard manages. Add one by pasting its SSH command: it's checked, set up like the others, and shows up everywhere. Tokens never reach the browser."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add machine
          </Button>
        }
      />

      {configErrors.length > 0 && (
        <Card className="border-amber-800/60 bg-amber-950/20 p-4 text-sm text-amber-200">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <ul className="list-disc pl-4">
              {configErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-[var(--line)] text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">System</th>
              <th className="px-4 py-2.5 font-medium">Agent</th>
              <th className="px-4 py-2.5 font-medium">Uptime</th>
              <th className="px-4 py-2.5 font-medium">Checked</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {vms.map((v) => {
              const s = status[v.name];
              const a = s?.agent;
              return (
                <tr key={v.name} className="align-top">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusDot state={vmState(s, Boolean(checking[v.name]))} />
                      <span className="font-medium whitespace-nowrap text-white">{v.name}</span>
                      {v.added && <span className="text-xs whitespace-nowrap text-zinc-500">added here</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    {a ? (
                      <>
                        <div className="whitespace-nowrap text-zinc-300">
                          {a.cores} vCPU · {Math.round(a.memTotalKb / 1048576)} GB RAM
                        </div>
                        <div className="text-xs whitespace-nowrap text-zinc-500">{a.os.replace(/ GNU\/Linux/, "")} · {v.host}</div>
                      </>
                    ) : (
                      <span className={s && !s.ok ? "text-rose-300" : "text-zinc-600"}>{s?.error ?? "—"}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {a ? (
                      <span className={cx("text-xs whitespace-nowrap", a.v === agentVersion ? "text-zinc-400" : "text-[var(--warning)]")}>
                        {a.v === agentVersion ? "Up to date" : "Updating…"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-400">{a ? fmtDuration(a.uptimeSec) : "—"}</td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap text-zinc-500">
                    {timeAgo(s?.checkedAt)}
                    {s?.ok && <span className="text-zinc-600"> · {s.ms} ms</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => refresh([v.name])} loading={checking[v.name]}>
                        Check
                      </Button>
                      {v.added && (
                        <Button size="sm" variant="ghost" onClick={() => void rename(v.name)} title="Rename">
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {v.added && (
                        <Button size="sm" variant="ghost" onClick={() => void remove(v.name)} loading={removing === v.name} className="hover:text-[var(--critical-text)]" title="Remove from the dashboard">
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>Add a machine</SectionTitle>
          <ol className="list-decimal space-y-2 pl-4 text-sm text-zinc-400">
            <li>
              Create the machine in InstaBox, then <b className="text-zinc-300">Details → SSH → Create token</b>.
            </li>
            <li>
              Click <b className="text-zinc-300">Add machine</b> and paste the SSH command (or tell the Assistant &quot;add this machine: …&quot;).
            </li>
            <li>It&apos;s checked, gets the agent, tunnels to your databases and the keep-alive task, and appears on Overview, Pipeline and here. New deploys can be placed on it right away.</li>
          </ol>
          <p className="mt-4 text-xs text-zinc-500">
            Any Linux server works too: paste <code className="text-zinc-300">user@host:22</code> (it logs in with the dashboard&apos;s SSH key). Machines in the{" "}
            <code className="text-zinc-300">VMS</code> env var keep working as before.
          </p>
        </Card>
        <Card className="p-5">
          <SectionTitle>Security</SectionTitle>
          <ul className="space-y-3 text-sm text-zinc-400">
            <li className="flex gap-2">
              {hostKeyPinned ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />}
              <span>
                {hostKeyPinned
                  ? "The InstaBox gateway's host key is pinned, so a spoofed server can't get your tokens."
                  : "Gateway host key is not pinned. Set INSTABOX_HOST_KEY_SHA256 to refuse impostor servers."}
              </span>
            </li>
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
              <span>Tokens live only in server env vars. The browser sees masked names, never the token.</span>
            </li>
            <li className="flex gap-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
              <span>
                Anyone with the admin password can run commands with sudo on every VM. Use a long password and rotate{" "}
                <code className="text-zinc-300">SESSION_SECRET</code> to sign everyone out.
              </span>
            </li>
          </ul>
        </Card>
      </div>
      {adding && <AddMachine onClose={() => setAdding(false)} onAdded={() => void reloadVms()} />}
    </div>
  );
}

function AddMachine({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [ssh, setSsh] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; summary: string[] } | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ name: string; summary: string[] }>("/api/machines", { ssh, name: name || undefined });
      setDone(r);
      setSsh("");
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Add a machine" subtitle="Checked, set up like the others, and managed from here on." onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-lg font-semibold text-white">
            <Check className="size-5 text-accent-soft" /> {done.name} is ready
          </p>
          <ul className="space-y-1.5 text-sm text-ink">
            {done.summary.map((l) => (
              <li key={l}>• {l}</li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDone(null)}>Add another</Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="SSH command, token or user@host" hint="From InstaBox: Details → SSH → copy the command. The token is encrypted and kept on your storage machine.">
            <textarea
              value={ssh}
              onChange={(e) => setSsh(e.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder="ssh -p 2222 ibssh_…@ssh.instabox.sh"
              className={cx(inputCls, "font-mono text-xs")}
            />
          </Field>
          <Field label="Name (optional)" hint="Defaults to the next free boxN.">
            <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="box6" className={inputCls} />
          </Field>
          {error && <p className="text-sm text-[var(--critical-text)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={add} loading={busy} disabled={ssh.trim().length < 8}>
              {busy ? "Connecting and setting up…" : "Add machine"}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
