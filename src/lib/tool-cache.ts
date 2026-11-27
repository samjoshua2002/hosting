// Reuse screenshots, site captures and comparisons within a session instead of opening a browser again for a page
// that can't have changed: an outside site's page is reused for 6 hours; the user's own pages until the session
// commits or deploys something (that is when they can change). Stored on the dashboard's storage, so it survives
// the server continuing a long run in a new request.
import { createHash } from "node:crypto";
import { storeGetJson, storePut } from "./store";

const OUTSIDE_TTL = 6 * 3600_000;
const OWN_TTL = 60 * 60_000;

interface Entry {
  at: number;
  output: string;
}

const dir = (session: string) => `cache/tools/${session.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "none"}`;
const keyOf = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);

/** The session changed something that is deployed (commit, deploy, assets, version switch): its own pages may look different now. */
export async function markChanged(session: string | undefined): Promise<void> {
  if (!session) return;
  await storePut(`${dir(session)}/changed.json`, JSON.stringify({ at: Date.now() })).catch(() => {});
}

/** A saved result for the same tool and arguments that is still valid, or null. own: the URLs include the user's own pages. */
export async function cached(session: string | undefined, tool: string, args: unknown[], own: boolean): Promise<{ output: string; ageMin: number } | null> {
  if (!session) return null;
  const e = await storeGetJson<Entry>(`${dir(session)}/${tool}-${keyOf(args)}.json`).catch(() => null);
  if (!e) return null;
  const age = Date.now() - e.at;
  if (age > (own ? OWN_TTL : OUTSIDE_TTL)) return null;
  if (own) {
    const ch = await storeGetJson<{ at: number }>(`${dir(session)}/changed.json`).catch(() => null);
    if (ch && ch.at >= e.at) return null;
  }
  return { output: e.output, ageMin: Math.max(1, Math.round(age / 60_000)) };
}

export async function remember(session: string | undefined, tool: string, args: unknown[], output: string): Promise<void> {
  if (!session) return;
  await storePut(`${dir(session)}/${tool}-${keyOf(args)}.json`, JSON.stringify({ at: Date.now(), output } satisfies Entry)).catch(() => {});
}
