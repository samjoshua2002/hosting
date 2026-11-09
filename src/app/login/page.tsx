"use client";

import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint, Layers, Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { PhotoCredit, UnsplashLayer, useTheme } from "@/components/theme";

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
    <main className="grid min-h-dvh grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] bg-bg">
      {/* left: the session's Unsplash gradient art */}
      <div className="p-3">
        <UnsplashLayer photo={photo} className="login-art h-full min-h-[calc(100dvh-1.5rem)] rounded-[28px]">
          <div className="flex h-full min-h-[calc(100dvh-1.5rem)] flex-col justify-between p-10">
            <div className="flex items-center gap-2.5">
              <span className="grid size-10 place-items-center rounded-xl bg-white/15 ring-1 ring-white/25 backdrop-blur">
                <Layers className="size-5 text-white" />
              </span>
              <span className="text-lg font-semibold text-white drop-shadow">hosting</span>
            </div>
            <div>
              <h1 className="max-w-md text-5xl leading-[1.05] font-extrabold tracking-[-0.03em] text-white drop-shadow-lg">
                Every server you run, in one place.
              </h1>
              <p className="mt-4 max-w-md text-[15px] text-white/85 drop-shadow">
                Deploy apps, databases and local models across your machines, and watch them all live.
              </p>
              <div className="mt-8 [&_a]:text-white/90 [&_span]:text-white/70">
                <PhotoCredit photo={photo} />
              </div>
            </div>
          </div>
        </UnsplashLayer>
      </div>

      {/* right: sign in */}
      <div className="flex items-center justify-center px-12">
        <div className="w-full max-w-sm">
          <h2 className="text-3xl font-bold tracking-tight text-white">Welcome back</h2>
          <p className="mt-2 text-sm text-muted">Sign in to your control panel.</p>

          {methods && !methods.configured && (
            <p className="mt-6 rounded-xl border border-[var(--warning)]/40 p-3 text-sm text-ink">
              The server has no ADMIN_PASSWORD / SESSION_SECRET yet, so sign-in is disabled.
            </p>
          )}

          <div className="mt-8 space-y-5">
            {methods?.passkey && (
              <button
                onClick={withPasskey}
                disabled={busy !== null}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-sm font-semibold text-black transition-colors hover:bg-white/85 disabled:opacity-60"
              >
                {busy === "passkey" ? <Loader2 className="size-4 animate-spin" /> : <Fingerprint className="size-4" />}
                Sign in with passkey
              </button>
            )}

            {methods?.passkey && methods.password && (
              <div className="flex items-center gap-3 text-[11px] text-muted">
                <span className="h-px flex-1 bg-white/10" /> or with password <span className="h-px flex-1 bg-white/10" />
              </div>
            )}

            {methods?.password !== false && (
              <form onSubmit={withPassword} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted" htmlFor="pw">
                    Admin password
                  </label>
                  <input
                    id="pw"
                    type="password"
                    autoFocus={!methods?.passkey}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-12 w-full rounded-xl border border-line-strong bg-panel px-4 text-sm text-white focus:border-accent focus:outline-none"
                  />
                </div>
                <button
                  disabled={busy !== null || !password}
                  className={`flex h-12 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors disabled:opacity-50 ${
                    methods?.passkey ? "border border-white/15 text-white hover:bg-white/5" : "bg-white text-black hover:bg-white/85"
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
            {error && <p className="text-sm text-[var(--critical-text)]">{error}</p>}
          </div>
        </div>
      </div>
    </main>
  );
}
