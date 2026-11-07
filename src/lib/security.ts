// Request-level protections: client IP, login throttling, audit logging, destructive-command detection.
import type { NextRequest } from "next/server";

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

/**
 * Login throttle: 5 failures per IP per 15 minutes, then locked for 15 minutes.
 * In-memory, so it is per server instance. Add a Vercel Firewall rate-limit rule for a global limit.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

export function loginLocked(ip: string): number {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.lockedUntil > Date.now()) return Math.ceil((f.lockedUntil - Date.now()) / 1000);
  if (Date.now() - f.first > WINDOW_MS) failures.delete(ip);
  return 0;
}

/** Records a failure; returns true exactly when this failure triggers the lockout. */
export function recordLoginFailure(ip: string): boolean {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || now - f.first > WINDOW_MS) {
    failures.set(ip, { count: 1, first: now, lockedUntil: 0 });
    return false;
  }
  f.count += 1;
  if (f.count >= MAX_FAILURES && f.lockedUntil < now) {
    f.lockedUntil = now + WINDOW_MS;
    return true;
  }
  return false;
}

export function clearLoginFailures(ip: string): void {
  failures.delete(ip);
}

/** One structured line per privileged action, visible in Vercel → Logs. */
export function audit(req: NextRequest, action: string, detail: Record<string, unknown>): void {
  console.info(
    JSON.stringify({ audit: action, at: new Date().toISOString(), ip: clientIp(req), ua: req.headers.get("user-agent")?.slice(0, 120), ...detail }),
  );
}
