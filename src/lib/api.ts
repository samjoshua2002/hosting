// Helpers shared by route handlers.
import { connection, type NextRequest } from "next/server";
import { refreshMachines } from "./machines";
import { verifySession } from "./auth";
import { getVm, type VmConfig } from "./config";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Every API route calls this, even though proxy.ts also guards /api (defence in depth). */
export async function requireAuth(req: NextRequest): Promise<void> {
  if (!(await verifySession(req.cookies))) throw new HttpError(401, "unauthorized");
}

export async function readJson<T>(req: NextRequest, maxBytes = 200_000): Promise<T> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new HttpError(415, "expected JSON");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "request too large");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export function vmOrThrow(name: unknown): VmConfig {
  const vm = typeof name === "string" ? getVm(name) : undefined;
  if (!vm) throw new HttpError(404, `unknown VM: ${String(name)}`);
  return vm;
}

export function vmsOrThrow(names: unknown): VmConfig[] {
  if (!Array.isArray(names) || names.length === 0) throw new HttpError(400, "pick at least one VM");
  return [...new Set(names)].map(vmOrThrow);
}

/**
 * Cross-site request guard for state-changing calls: the browser's Origin must be this host.
 * (Cookies are SameSite=Lax and bodies must be JSON, so this is a third, independent layer.)
 */
function checkOrigin(req: NextRequest): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) throw new HttpError(403, "missing origin");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "bad origin");
  }
  // behind the Vercel front door the backend may see its own host: the dashboard's public address counts too
  let front = "";
  try {
    front = process.env.APP_URL ? new URL(process.env.APP_URL).host : "";
  } catch {
    /* ignore a malformed APP_URL */
  }
  if (originHost !== host && originHost !== front) throw new HttpError(403, "cross-site request blocked");
}

export function handle(fn: (req: NextRequest) => Promise<Response>) {
  return async (req: NextRequest): Promise<Response> => {
    // Marks the route as request-time. Must stay outside the try: during build it rejects on purpose.
    await connection();
    try {
      checkOrigin(req);
      await refreshMachines();
      const res = await fn(req);
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status, headers: { "Cache-Control": "no-store" } });
      console.error(e);
      return Response.json({ error: e instanceof Error ? e.message : "server error" }, { status: 500 });
    }
  };
}
