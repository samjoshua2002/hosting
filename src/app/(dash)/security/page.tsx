"use client";

import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { Check, Copy, Fingerprint, Mail, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageHero } from "@/components/page-hero";
import { Badge, Button, Card, Field, SectionTitle, cx, inputCls } from "@/components/ui";
import { api } from "@/lib/client";

interface Overview {
  rpID: string;
  origin: string;
  appUrlPinned: boolean;
  passkeys: { name: string; rpID: string; id: string; here: boolean }[];
  passwordLogin: boolean;
  passwordStrong: boolean;
  https: boolean;
  hostKeyPinned: boolean;
  mail: boolean;
  mailTo: string;
  ai: boolean;
  cron: boolean;
}

export default function SecurityPage() {
  const [o, setO] = useState<Overview | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ entry: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailState, setMailState] = useState<"idle" | "sending" | "sent" | string>("idle");
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => api<Overview>("/api/auth/passkey/list").then(setO).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const addPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkey/register", { step: "options" });
      const response = await startRegistration({ optionsJSON: options });
      const res = await api<{ entry: string; value: string }>("/api/auth/passkey/register", { step: "verify", response, name: name || deviceName() });
      setCreated(res);
    } catch (e) {
      const msg = (e as Error).message;
      setError(/NotAllowed|cancel|abort/i.test(msg) ? "Passkey prompt was cancelled." : msg);
    } finally {
      setBusy(false);
    }
  };

  const testMail = async () => {
    setMailState("sending");
    try {
      await api("/api/alerts/test", {});
      setMailState("sent");
    } catch (e) {
      setMailState((e as Error).message);
    }
  };

  const checks: { ok: boolean; label: string; fix: string }[] = o
    ? [
        { ok: o.https, label: "Served over HTTPS", fix: "Deploy to Vercel (HTTPS by default)." },
        { ok: o.passkeys.some((p) => p.here), label: "Passkey registered for this domain", fix: "Add one below, then save it to PASSKEYS." },
        { ok: !o.passwordLogin, label: "Password sign-in turned off", fix: "After your passkey works, set PASSWORD_LOGIN=off." },
        { ok: o.passwordStrong, label: "Admin password is long (16+ characters)", fix: "Use the generated one from npm run env:sync." },
        { ok: o.appUrlPinned, label: "APP_URL pins the domain", fix: "Set APP_URL=https://<your-domain> so passkeys can't be phished on another host." },
        { ok: o.hostKeyPinned, label: "InstaBox gateway host key pinned", fix: "Set INSTABOX_HOST_KEY_SHA256." },
        { ok: o.mail, label: "Email alerts configured", fix: "Set EMAIL_USER and EMAIL_PASS (Gmail app password)." },
        { ok: o.cron, label: "Daily health check secret set", fix: "Set CRON_SECRET (Vercel cron calls /api/cron/health)." },
      ]
    : [];
  const score = checks.filter((c) => c.ok).length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-10 py-8">
      <PageHero eyebrow="Access & alerts" title="Security" icon={<ShieldCheck className="size-6" />} desc="Sign-in methods, email alerts and a hardening checklist for this dashboard." />
      {error && <p className="rounded-lg bg-rose-950/40 p-3 text-sm text-rose-300">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card className="p-6">
          <SectionTitle right={<Badge tone="blue">domain: {o?.rpID ?? "…"}</Badge>}>Passkeys</SectionTitle>
          <p className="text-sm text-muted">
            Passkeys use Face ID, Touch ID, Windows Hello or a security key, so there is nothing to phish or leak. Each passkey works on the
            domain it was created on.
          </p>
          <ul className="mt-4 space-y-2">
            {o?.passkeys.length ? (
              o.passkeys.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded-xl bg-black/25 px-4 py-2.5 text-sm">
                  <span className="flex items-center gap-2">
                    <Fingerprint className="size-4 text-accent-soft" />
                    <span className="font-medium text-white">{p.name}</span>
                    <span className="font-mono text-xs text-muted">{p.id}</span>
                  </span>
                  <Badge tone={p.here ? "green" : "gray"}>{p.here ? "this domain" : p.rpID}</Badge>
                </li>
              ))
            ) : (
              <li className="rounded-xl bg-black/25 px-4 py-3 text-sm text-muted">No passkeys yet.</li>
            )}
          </ul>

          {created ? (
            <div className="mt-5 space-y-3 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-4 text-sm">
              <p className="font-semibold text-white">Passkey created. One step left: save it on the server.</p>
              <p className="text-ink/80">
                In Vercel → Settings → Environment Variables, set <code className="text-white">PASSKEYS</code> to the value below and redeploy.
                Locally, put the same line in <code className="text-white">.env.local</code>. It holds only public keys.
              </p>
              <pre className="max-h-32 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] break-all whitespace-pre-wrap text-ink">
                PASSKEYS=&quot;{created.value}&quot;
              </pre>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(`PASSKEYS="${created.value}"`);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <div className="mt-5 flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <Field label="Name for this passkey">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder={deviceName()} className={inputCls} />
                </Field>
              </div>
              <Button variant="primary" onClick={addPasskey} loading={busy} disabled={typeof window !== "undefined" && !browserSupportsWebAuthn()}>
                <Fingerprint className="size-4" /> Add passkey on this device
              </Button>
            </div>
          )}
        </Card>

        <Card className="p-6">
          <SectionTitle right={o && <span className="text-sm font-semibold text-white">{score}/{checks.length}</span>}>Hardening checklist</SectionTitle>
          <ul className="space-y-2.5">
            {checks.map((c) => (
              <li key={c.label} className="flex gap-2.5 text-sm">
                {c.ok ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--good-text)]" /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />}
                <span>
                  <span className={cx(c.ok ? "text-zinc-200" : "text-white")}>{c.label}</span>
                  {!c.ok && <span className="block text-xs text-muted">{c.fix}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-6">
          <SectionTitle>Email alerts</SectionTitle>
          <p className="text-sm text-muted">
            {o?.mail ? (
              <>
                Alerts go to <b className="text-white">{o.mailTo}</b> (set <code>ALERT_EMAIL_TO</code> to change). You get one for every sign-in,
                for repeated failed sign-ins, when the dashboard sees a VM go down or a project fail, and from the daily health check.
              </>
            ) : (
              "Set EMAIL_USER and EMAIL_PASS to turn on email alerts."
            )}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={testMail} loading={mailState === "sending"} disabled={!o?.mail}>
              <Mail className="size-4" /> Send test email
            </Button>
            {mailState === "sent" && <span className="flex items-center gap-1 text-sm text-[var(--good-text)]"><Check className="size-4" /> Sent</span>}
            {mailState !== "idle" && mailState !== "sending" && mailState !== "sent" && (
              <span className="flex items-center gap-1 text-sm text-rose-300"><X className="size-4" /> {mailState}</span>
            )}
          </div>
        </Card>
        <Card className="p-6">
          <SectionTitle>What protects this dashboard</SectionTitle>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted">
            <li>Signed, HttpOnly, SameSite session cookie (12 h), <code>__Host-</code> prefixed on HTTPS.</li>
            <li>Every API call re-checks the session, and changes must come from this origin as JSON (CSRF).</li>
            <li>5 wrong passwords lock that IP out for 15 minutes, with an email alert.</li>
            <li>Strict security headers: CSP, no framing, HSTS, nosniff, no referrer leaks, noindex.</li>
            <li>VM tokens and keys stay server-side; the InstaBox host key is pinned against impostor servers.</li>
            <li>Every command, deploy and sign-in is written to the audit log (Vercel → Logs).</li>
            <li>The AI agent can only read: every change it proposes waits for your click.</li>
            <li>Destructive commands (rm -rf, mkfs, reboot…) ask for confirmation first.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function deviceName(): string {
  if (typeof navigator === "undefined") return "my device";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "my device";
}
