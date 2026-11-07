"use client";

import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { UnsplashLayer, useTheme } from "@/components/theme";

interface Methods {
  configured: boolean;
  password: boolean;
  passkey: boolean;
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, error: data.error };
}

export default function LoginPage() {
  const { photo } = useTheme();
  const [methods, setMethods] = useState<Methods | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);

  useEffect(() => {
    fetch("/api/auth/methods", { cache: "no-store" })
      .then((r) => r.json())
      .then((m: Methods) => setMethods({ ...m, passkey: m.passkey && browserSupportsWebAuthn() }))
      .catch(() => setMethods({ configured: true, password: true, passkey: false }));
  }, []);

  const done = () => window.location.replace("/");

  const withPasskey = async () => {
    setBusy("passkey");
    setError(null);
    try {
      const optRes = await fetch("/api/auth/passkey/options", { cache: "no-store" });
      const options = await optRes.json();
      if (!optRes.ok) throw new Error(options.error ?? "Could not start passkey sign-in");
      const response = await startAuthentication({ optionsJSON: options });
      const r = await post("/api/auth/passkey/verify", { response });
      if (!r.ok) throw new Error(r.error ?? "Passkey sign-in failed");
      done();
    } catch (e) {
      const msg = (e as Error).message;
      setError(/NotAllowed|aborted|cancel/i.test(msg) ? "Passkey prompt was cancelled." : msg);
    } finally {
      setBusy(null);
    }
  };

  const withPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("password");
    setError(null);
    try {
      const r = await post("/api/auth/login", { password });
      if (r.ok) return done();
      setError(r.error ?? "Login failed");
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="relative isolate grid min-h-dvh place-items-center px-4">
      <UnsplashLayer photo={photo} className="page-cover !h-[60vh]" />
      <div className="w-full max-w-sm rounded-3xl border border-white/[0.07] bg-[var(--panel)]/90 p-7 shadow-2xl backdrop-blur">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40">
            <KeyRound className="size-5 text-accent-soft" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-white">Hosting control</h1>
            <p className="text-xs text-muted">Sign in to manage your fleet</p>
          </div>
        </div>

        {methods && !methods.configured && (
          <p className="mb-4 rounded-lg bg-amber-950/40 p-3 text-sm text-amber-200">
            The server has no ADMIN_PASSWORD / SESSION_SECRET yet, so sign-in is disabled.
          </p>
        )}

        {methods?.passkey && (
          <button
            onClick={withPasskey}
            disabled={busy !== null}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-white text-sm font-semibold text-[#0b0e1c] transition-colors hover:bg-white/85 disabled:opacity-60"
          >
            {busy === "passkey" ? <Loader2 className="size-4 animate-spin" /> : <Fingerprint className="size-4" />}
            Sign in with passkey
          </button>
        )}

        {methods?.passkey && methods.password && (
          <div className="my-5 flex items-center gap-3 text-[11px] text-muted">
            <span className="h-px flex-1 bg-white/10" /> or use the password <span className="h-px flex-1 bg-white/10" />
          </div>
        )}

        {methods?.password !== false && (
          <form onSubmit={withPassword}>
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="pw">
              Admin password
            </label>
            <input
              id="pw"
              type="password"
              autoFocus={!methods?.passkey}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-[var(--line-strong)] bg-black/25 px-3 py-2.5 text-sm focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              disabled={busy !== null || !password}
              className={`mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold disabled:opacity-50 ${
                methods?.passkey ? "border border-white/15 text-white hover:bg-white/5" : "bg-white text-[#0b0e1c] hover:bg-white/85"
              }`}
            >
              {busy === "password" && <Loader2 className="size-4 animate-spin" />}
              Sign in
            </button>
          </form>
        )}

        {methods && !methods.password && !methods.passkey && (
          <p className="text-sm text-muted">Password sign-in is off and no passkey is registered for this domain.</p>
        )}
        {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}
      </div>
    </main>
  );
}
