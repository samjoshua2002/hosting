"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/** fetch wrapper for our API: JSON in/out, redirects to /login on 401, throws on errors. */
export async function api<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    ...init,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    storeDown(res.status, data);
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

/** The storage machine is resting: tell the page (the shell shows a banner with the choice). */
function storeDown(status: number, data: unknown) {
  if (status === 503 && (data as { code?: string })?.code === "store_down" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("store-down", { detail: data }));
}

/** POST and read an NDJSON stream, calling onLine for each parsed line. */
export async function apiStream<T>(path: string, body: unknown, onLine: (line: T) => void): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    storeDown(res.status, data);
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(JSON.parse(line) as T);
    }
    if (done) break;
  }
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}


/** localStorage-backed state that is hydration-safe (server snapshot = fallback) and syncs across tabs. */
export function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      const onStorage = (e: StorageEvent) => e.key === key && cb();
      window.addEventListener("storage", onStorage);
      window.addEventListener(`stored:${key}`, cb);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(`stored:${key}`, cb);
      };
    },
    [key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const fallbackJson = JSON.stringify(fallback);
  const value = useMemo<T>(() => {
    try {
      return JSON.parse(raw ?? fallbackJson) as T;
    } catch {
      return JSON.parse(fallbackJson) as T;
    }
  }, [raw, fallbackJson]);
  const set = useCallback(
    (v: T) => {
      writeLocal(key, v);
      window.dispatchEvent(new Event(`stored:${key}`));
    },
    [key],
  );
  return [value, set];
}

const noop = () => () => {};

/** One URL search param, read without useSearchParams (no Suspense boundary needed). */
export function useSearchParam(name: string): string | null {
  return useSyncExternalStore(
    noop,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  );
}
