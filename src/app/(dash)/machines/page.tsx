"use client";

import { AlertTriangle, Server, ShieldCheck, ShieldAlert } from "lucide-react";
import { useCluster } from "@/components/cluster";
import { PageHero } from "@/components/page-hero";
import { Badge, Button, Card, SectionTitle, StatusDot } from "@/components/ui";
import { fmtDuration, timeAgo, vmState } from "@/lib/format";

export default function VmsPage() {
  const { vms, status, checking, refresh, configErrors, agentVersion, hostKeyPinned } = useCluster();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
      <PageHero
        eyebrow="Fleet"
        title="Machines"
        icon={<Server className="size-6" />}
        desc={<>Every machine listed in the <code className="text-white">VMS</code> environment variable. Add as many as you like; tokens never reach the browser.</>}
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
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="border-b border-[var(--line)] text-zinc-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Endpoint</th>
              <th className="px-4 py-2.5 font-medium">Machine</th>
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
                      <span className="font-mono font-semibold text-zinc-200">{v.name}</span>
                      <Badge>{v.kind}</Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-400">
                    {v.userHint}@{v.host}:{v.port}
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    {a ? (
                      <>
                        <div className="text-zinc-300">{a.hostname}</div>
                        <div className="text-zinc-500">
                          {a.os} · {a.cores} vCPU
                        </div>
                      </>
                    ) : (
                      <span className={s && !s.ok ? "text-rose-300" : "text-zinc-600"}>{s?.error ?? "—"}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {a ? <Badge tone={a.v === agentVersion ? "green" : "amber"}>{a.v === agentVersion ? "up to date" : a.v}</Badge> : "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-400">{a ? fmtDuration(a.uptimeSec) : "—"}</td>
                  <td className="px-4 py-3 text-zinc-500">
                    {timeAgo(s?.checkedAt)}
                    {s?.ok && <div className="text-zinc-600">{s.ms} ms</div>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" onClick={() => refresh([v.name])} loading={checking[v.name]}>
                      Check
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>Add a VM</SectionTitle>
          <ol className="list-decimal space-y-2 pl-4 text-sm text-zinc-400">
            <li>
              Create the machine in InstaBox, then <b className="text-zinc-300">Details → SSH → Create token</b>.
            </li>
            <li>
              Add it to the <code className="text-zinc-300">VMS</code> variable in Vercel (Settings → Environment Variables), comma-separated:
              <pre className="mt-2 overflow-x-auto rounded-md bg-black/50 p-3 font-mono text-[11px] text-zinc-300">
                {"box1=ibssh_aaaa,box2=ibssh_bbbb,box6=ibssh_new"}
              </pre>
              Locally: add the token to <code className="text-zinc-300">tokens.txt</code> and run{" "}
              <code className="text-zinc-300">npm run env:sync</code>.
            </li>
            <li>Redeploy on Vercel (env changes apply on the next deployment). The agent installs itself on first contact.</li>
          </ol>
          <p className="mt-4 text-xs text-zinc-500">
            Non-InstaBox servers work too: <code className="text-zinc-300">web=deploy@203.0.113.7:22</code> plus an{" "}
            <code className="text-zinc-300">SSH_PRIVATE_KEY</code> variable.
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
    </div>
  );
}
