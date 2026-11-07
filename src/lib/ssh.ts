import { Client, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { VmConfig } from "./config";

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  /** Cap per stream; output beyond this is dropped and `truncated` is set. */
  maxBytes?: number;
}

export interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

// The InstaBox gateway holds the connection up to ~15s while it wakes a paused machine.
const CONNECT_TIMEOUT_MS = 30_000;

function friendly(err: unknown, vm: VmConfig): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/authentication methods failed/i.test(msg))
    return new Error(
      vm.kind === "instabox" ? "Login refused: token invalid or deleted in InstaBox" : "Login refused (check SSH_PRIVATE_KEY)",
    );
  if (/Timed out while waiting for handshake/i.test(msg)) return new Error("Timed out connecting (machine may be in cooldown)");
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) return new Error(`Cannot reach ${vm.host}:${vm.port}`);
  return new Error(msg);
}

export function connect(vm: VmConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let hostKeyMismatch = false;
    const cfg: ConnectConfig = {
      host: vm.host,
      port: vm.port,
      username: vm.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 10_000,
    };
    if (vm.privateKey) cfg.privateKey = vm.privateKey;
    if (vm.hostKeys.length) {
      cfg.hostVerifier = (key: Buffer) => {
        const fp = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
        hostKeyMismatch = !vm.hostKeys.includes(fp);
        return !hostKeyMismatch;
      };
    }
    conn
      .on("ready", () => resolve(conn))
      .on("error", (err) =>
        reject(hostKeyMismatch ? new Error(`Host key for ${vm.host} does not match the pinned fingerprint`) : friendly(err, vm)),
      )
      .connect(cfg);
  });
}

export function run(conn: Client, command: string, opts: RunOptions = {}): Promise<RunOutput> {
  const { stdin, timeoutMs = 50_000, maxBytes = 256 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(errOut).toString("utf8"),
          truncated,
          timedOut,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        stream.signal("KILL");
        stream.close();
        finish(null);
      }, timeoutMs);

      stream.on("data", (d: Buffer) => {
        if (outBytes < maxBytes) out.push(d.subarray(0, maxBytes - outBytes));
        else truncated = true;
        outBytes += d.length;
      });
      stream.stderr.on("data", (d: Buffer) => {
        if (errBytes < maxBytes) errOut.push(d.subarray(0, maxBytes - errBytes));
        else truncated = true;
        errBytes += d.length;
      });
      stream.on("close", (code: number | null) => finish(typeof code === "number" ? code : null));
      stream.on("error", (e: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });
      stream.end(stdin ?? undefined);
    });
  });
}

/** Open a connection, run `fn`, always close. */
export async function withVm<T>(vm: VmConfig, fn: (conn: Client) => Promise<T>): Promise<T> {
  const conn = await connect(vm);
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

/** POSIX single-quote escaping. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
