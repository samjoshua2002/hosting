// Small document + file store on the storage machine (STORE_VM, default box5), reached over SSH.
// Used for Assistant sessions and attachments, so they follow you across browsers and devices.
import { getVm, type VmConfig } from "./config";
import { run, withVm } from "./ssh";

const ROOT = '"$HOME/.hosting/store"';
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export function storeVm(): VmConfig {
  const name = process.env.STORE_VM || "box5";
  const vm = getVm(name);
  if (!vm) throw new Error(`storage machine ${name} is not in VMS`);
  return vm;
}

function check(path: string): string {
  if (!SAFE.test(path) || path.includes("..")) throw new Error(`bad store path: ${path}`);
  return `${ROOT}/${path}`;
}

export async function storePut(path: string, data: Buffer | string): Promise<void> {
  const p = check(path);
  const b64 = (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64");
  await withVm(storeVm(), async (c) => {
    const r = await run(c, `umask 077; mkdir -p "$(dirname ${p})" && t=${p}.tmp.$$; base64 -d > "$t" && mv -f "$t" ${p} || { rm -f "$t"; exit 1; }`, { stdin: b64, timeoutMs: 40_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "store write failed");
  });
}

export async function storeGet(path: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
  const p = check(path);
  return withVm(storeVm(), async (c) => {
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
    throw new Error(`${path} on the storage machine is damaged (not valid JSON)`);
  }
}

export async function storeDelete(path: string): Promise<void> {
  const p = check(path);
  await withVm(storeVm(), async (c) => {
    await run(c, `rm -rf ${p}`, { timeoutMs: 20_000 });
  });
}

/** Files directly inside a directory: name, size in bytes, modified (unix seconds). */
export async function storeList(dir: string): Promise<{ name: string; size: number; mtime: number }[]> {
  const p = check(dir);
  return withVm(storeVm(), async (c) => {
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
 * Write a file and, in the same SSH session, look for (and consume) a flag file. Used by running
 * Assistant sessions: save progress and learn whether the user pressed Stop, in one round trip.
 * clearFlag removes a stale flag without reporting it (at the start of a run).
 */
export async function storePutAndTakeFlag(path: string, data: string, flag: string, clearFlag = false): Promise<boolean> {
  const p = check(path);
  const f = check(flag);
  const b64 = Buffer.from(data, "utf8").toString("base64");
  return withVm(storeVm(), async (c) => {
    const take = clearFlag ? `rm -f ${f}` : `if [ -f ${f} ]; then rm -f ${f}; echo __FLAG__; fi`;
    const r = await run(c, `umask 077; mkdir -p "$(dirname ${p})" && t=${p}.tmp.$$; { base64 -d > "$t" && mv -f "$t" ${p}; } || { rm -f "$t"; exit 1; }; ${take}`, { stdin: b64, timeoutMs: 40_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "store write failed");
    return r.stdout.includes("__FLAG__");
  });
}

/** Every *.json file directly in a directory, read in one round trip. */
export async function storeReadJsonDir<T>(dir: string): Promise<{ name: string; value: T }[]> {
  const p = check(dir);
  return withVm(storeVm(), async (c) => {
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
