// Small document + file store for Assistant sessions, attachments, memory, the vault, the machine registry,
// Autopilot and the failover copy. Two backends with the same behavior:
//   - Postgres (DATABASE_URL set): the dashboard's own database, independent of any machine. Recommended.
//   - One of the user's own machines over SSH (files under ~/.hosting/store): STORE_VM at first, with a copy on a
//     second machine each Autopilot pass and a switch the user can make while it rests (store-location.ts).
import { Pool } from "pg";
import { getVm, type VmConfig } from "./config";
import { run } from "./ssh";
import { withStore } from "./store-location";

const ROOT = '"$HOME/.hosting/store"';
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/** The machine the dashboard first kept its data on (the current one can differ: see store-location.ts). */
export function storeVm(): VmConfig {
  const name = process.env.STORE_VM || "box5";
  const vm = getVm(name);
  if (!vm) throw new Error(`storage machine ${name} is not in VMS`);
  return vm;
}

/** Where the dashboard keeps its data: "database" (Postgres) or the storage machine. */
export function storeBackend(): "database" | "machine" {
  return process.env.DATABASE_URL ? "database" : "machine";
}

function valid(path: string): string {
  if (!SAFE.test(path) || path.includes("..")) throw new Error(`bad store path: ${path}`);
  return path.replace(/\/+$/, "");
}
const check = (path: string) => `${ROOT}/${valid(path)}`;

/* ---------------- Postgres ---------------- */

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

function db(): Promise<Pool> {
  if (!pool) {
    const url = process.env.DATABASE_URL!;
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /sslmode=disable/.test(url);
    pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX) || 6, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000, ssl: local ? undefined : { rejectUnauthorized: false } });
    pool.on("error", () => {}); // a dropped idle connection must not crash the server
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS hosting_store (
           path text PRIMARY KEY,
           data bytea NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        // try again on the next call instead of staying broken
        const p = pool;
        pool = null;
        ready = null;
        void p?.end().catch(() => {});
        throw e;
      });
  }
  const p = pool;
  return ready!.then(() => p);
}

/** Direct children of dir: path LIKE 'dir/%' with no further slash. */
const childOf = `starts_with(path, $1 || '/') AND strpos(substr(path, length($1) + 2), '/') = 0`;

const pg = {
  async put(path: string, data: Buffer) {
    await (await db()).query(
      "INSERT INTO hosting_store (path, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [path, data],
    );
  },
  async get(path: string, maxBytes: number) {
    const r = await (await db()).query<{ data: Buffer; size: number }>("SELECT data, octet_length(data) AS size FROM hosting_store WHERE path = $1", [path]);
    if (!r.rows.length) return null;
    if (r.rows[0].size > maxBytes) throw new Error(`${path} is larger than ${Math.round(maxBytes / 1048576)} MB`);
    return r.rows[0].data;
  },
  async del(path: string) {
    // like rm -rf: the path itself and everything under it
    await (await db()).query("DELETE FROM hosting_store WHERE path = $1 OR starts_with(path, $1 || '/')", [path]);
  },
  async list(dir: string) {
    const r = await (await db()).query<{ path: string; size: number; mtime: number }>(
      `SELECT path, octet_length(data) AS size, extract(epoch FROM updated_at)::bigint AS mtime FROM hosting_store WHERE ${childOf} ORDER BY path`,
      [dir],
    );
    return r.rows.map((x) => ({ name: x.path.slice(dir.length + 1), size: Number(x.size), mtime: Number(x.mtime) }));
  },
  async putAndTakeFlag(path: string, data: Buffer, flag: string, clearFlag: boolean) {
    const client = await (await db()).connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO hosting_store (path, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
        [path, data],
      );
      const gone = await client.query("DELETE FROM hosting_store WHERE path = $1", [flag]);
      await client.query("COMMIT");
      return !clearFlag && (gone.rowCount ?? 0) > 0;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },
  async readJsonDir(dir: string) {
    const r = await (await db()).query<{ path: string; data: Buffer }>(`SELECT path, data FROM hosting_store WHERE ${childOf} AND right(path, 5) = '.json' ORDER BY path`, [dir]);
    return r.rows.map((x) => ({ name: x.path.slice(dir.length + 1), data: x.data }));
  },
};

/** How many entries the database holds (0 = fresh database). */
export async function storeRowCount(): Promise<number> {
  if (storeBackend() !== "database") return -1;
  const r = await (await db()).query<{ n: string }>("SELECT count(*)::text AS n FROM hosting_store");
  return Number(r.rows[0]?.n ?? 0);
}

/* ---------------- public API (same for both backends) ---------------- */

export async function storePut(path: string, data: Buffer | string): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  if (storeBackend() === "database") return pg.put(valid(path), buf);
  const p = check(path);
  await withStore(async (c) => {
    const r = await run(c, `umask 077; mkdir -p "$(dirname ${p})" && t=${p}.tmp.$$; base64 -d > "$t" && mv -f "$t" ${p} || { rm -f "$t"; exit 1; }`, { stdin: buf.toString("base64"), timeoutMs: 40_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "store write failed");
  });
}

export async function storeGet(path: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
  if (storeBackend() === "database") return pg.get(valid(path), maxBytes);
  const p = check(path);
  return withStore(async (c) => {
    const r = await run(c, `[ -f ${p} ] && base64 -w0 < ${p} || echo __MISSING__`, { timeoutMs: 40_000, maxBytes: Math.ceil(maxBytes * 1.4) });
    const out = r.stdout.trim();
    if (out === "__MISSING__") return null;
    if (r.truncated) throw new Error(`${path} is larger than ${Math.round(maxBytes / 1048576)} MB`);
    return Buffer.from(out, "base64");
  });
}

export async function storeGetJson<T>(path: string): Promise<T | null> {
  const b = await storeGet(path);
  if (!b) return null;
  try {
    return JSON.parse(b.toString("utf8")) as T;
  } catch {
    // a damaged file must not read as "empty": callers would overwrite it and lose the data
    throw new Error(`${path} in the dashboard's storage is damaged (not valid JSON)`);
  }
}

export async function storeDelete(path: string): Promise<void> {
  if (storeBackend() === "database") return pg.del(valid(path));
  const p = check(path);
  await withStore(async (c) => {
    await run(c, `rm -rf ${p}`, { timeoutMs: 20_000 });
  });
}

/** Files directly inside a directory: name, size in bytes, modified (unix seconds). */
export async function storeList(dir: string): Promise<{ name: string; size: number; mtime: number }[]> {
  if (storeBackend() === "database") return pg.list(valid(dir));
  const p = check(dir);
  return withStore(async (c) => {
    const r = await run(c, `[ -d ${p} ] && find ${p} -maxdepth 1 -type f -printf '%f\\t%s\\t%T@\\n' || true`, { timeoutMs: 20_000 });
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, size, mtime] = l.split("\t");
        return { name, size: Number(size), mtime: Math.floor(Number(mtime)) };
      });
  });
}

/**
 * Write a file and, in the same round trip, look for (and consume) a flag file. Used by running
 * Assistant sessions: save progress and learn whether the user pressed Stop, at once.
 * clearFlag removes a stale flag without reporting it (at the start of a run).
 */
export async function storePutAndTakeFlag(path: string, data: string, flag: string, clearFlag = false): Promise<boolean> {
  if (storeBackend() === "database") return pg.putAndTakeFlag(valid(path), Buffer.from(data, "utf8"), valid(flag), clearFlag);
  const p = check(path);
  const f = check(flag);
  const b64 = Buffer.from(data, "utf8").toString("base64");
  return withStore(async (c) => {
    const take = clearFlag ? `rm -f ${f}` : `if [ -f ${f} ]; then rm -f ${f}; echo __FLAG__; fi`;
    const r = await run(c, `umask 077; mkdir -p "$(dirname ${p})" && t=${p}.tmp.$$; { base64 -d > "$t" && mv -f "$t" ${p}; } || { rm -f "$t"; exit 1; }; ${take}`, { stdin: b64, timeoutMs: 40_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "store write failed");
    return r.stdout.includes("__FLAG__");
  });
}

/** Every *.json file directly in a directory, read in one round trip. */
export async function storeReadJsonDir<T>(dir: string): Promise<{ name: string; value: T }[]> {
  if (storeBackend() === "database") {
    const out: { name: string; value: T }[] = [];
    for (const x of await pg.readJsonDir(valid(dir)))
      try {
        out.push({ name: x.name, value: JSON.parse(x.data.toString("utf8")) as T });
      } catch {
        /* skip a broken file */
      }
    return out;
  }
  const p = check(dir);
  return withStore(async (c) => {
    const r = await run(c, `[ -d ${p} ] || exit 0; for f in ${p}/*.json; do [ -f "$f" ] || continue; printf '%s\\t' "$(basename "$f")"; base64 -w0 < "$f"; echo; done`, {
      timeoutMs: 30_000,
      maxBytes: 8 * 1024 * 1024,
    });
    const out: { name: string; value: T }[] = [];
    for (const line of r.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      try {
        out.push({ name: line.slice(0, tab), value: JSON.parse(Buffer.from(line.slice(tab + 1), "base64").toString("utf8")) as T });
      } catch {
        /* skip a broken file */
      }
    }
    return out;
  });
}
