// Server-only: reads VM credentials from environment variables.
import type { VmInfo, VmKind } from "./types";

export interface VmConfig {
  name: string;
  kind: VmKind;
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  /** Accepted SHA256 host-key fingerprints (base64, no "SHA256:" prefix). Empty = accept any. */
  hostKeys: string[];
}

interface Parsed {
  vms: VmConfig[];
  errors: string[];
}

let cache: { raw: string; parsed: Parsed } | null = null;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOKEN_RE = /^ibssh_[A-Za-z0-9]+$/;
const SSH_RE = /^([^@\s]+)@([^:\s]+)(?::(\d{1,5}))?$/;

function fingerprints(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^SHA256:/, "").replace(/=+$/, ""))
    .filter(Boolean);
}

function privateKey(): string | undefined {
  const raw = process.env.SSH_PRIVATE_KEY;
  if (raw) return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  const b64 = process.env.SSH_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  return undefined;
}

/**
 * VMS holds one entry per VM, separated by commas or newlines:
 *   box1=ibssh_xxxxxxxx            InstaBox machine (token is the SSH username)
 *   web=deploy@203.0.113.7:22      any other SSH server (uses SSH_PRIVATE_KEY)
 *   ibssh_xxxxxxxx                 unnamed entries become box<N>
 */
export function parseVms(raw: string): Parsed {
  const errors: string[] = [];
  const vms: VmConfig[] = [];
  const seen = new Set<string>();
  const ibHost = process.env.INSTABOX_SSH_HOST || "ssh.instabox.sh";
  const ibPort = Number(process.env.INSTABOX_SSH_PORT || 2222);
  const ibKeys = fingerprints(process.env.INSTABOX_HOST_KEY_SHA256);

  const entries = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));

  entries.forEach((entry, i) => {
    const eq = entry.indexOf("=");
    const name = (eq > 0 ? entry.slice(0, eq) : `box${i + 1}`).trim().toLowerCase();
    const value = (eq > 0 ? entry.slice(eq + 1) : entry).trim();

    if (!NAME_RE.test(name)) {
      errors.push(`Entry ${i + 1}: "${name}" is not a valid name (use a-z, 0-9, -).`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`Entry ${i + 1}: duplicate name "${name}".`);
      return;
    }

    if (TOKEN_RE.test(value)) {
      seen.add(name);
      vms.push({ name, kind: "instabox", host: ibHost, port: ibPort, username: value, hostKeys: ibKeys });
      return;
    }

    const m = SSH_RE.exec(value);
    if (m) {
      const key = privateKey();
      if (!key) errors.push(`${name}: SSH_PRIVATE_KEY is not set, so ${m[1]}@${m[2]} will likely fail to log in.`);
      seen.add(name);
      vms.push({
        name,
        kind: "ssh",
        host: m[2],
        port: m[3] ? Number(m[3]) : 22,
        username: m[1],
        privateKey: key,
        hostKeys: [],
      });
      return;
    }

    errors.push(`${name}: value is neither an InstaBox token (ibssh_…) nor user@host[:port].`);
  });

  return { vms, errors };
}

export function getConfig(): Parsed {
  const raw = process.env.VMS ?? "";
  if (cache?.raw !== raw) cache = { raw, parsed: parseVms(raw) };
  return cache.parsed;
}

export function getVms(): VmConfig[] {
  return getConfig().vms;
}

export function getVm(name: string): VmConfig | undefined {
  return getVms().find((v) => v.name === name);
}

function mask(u: string): string {
  return u.length <= 12 ? u.slice(0, 3) + "…" : `${u.slice(0, 9)}…${u.slice(-4)}`;
}

export function toInfo(vm: VmConfig): VmInfo {
  return {
    name: vm.name,
    kind: vm.kind,
    host: vm.host,
    port: vm.port,
    userHint: vm.kind === "instabox" ? mask(vm.username) : vm.username,
  };
}
