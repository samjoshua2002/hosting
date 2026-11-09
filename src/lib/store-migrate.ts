// Moving the dashboard's data from the storage machine (STORE_VM, default box5) into Postgres. The machine's
// copy is left untouched. Runs by itself the first time a server with DATABASE_URL starts on an empty database,
// or by hand: npx tsx scripts/migrate-store.mts
import { getVms } from "./config";
import { run, withVm } from "./ssh";
import { storeBackend, storeGet, storePut, storeRowCount } from "./store";

export interface MigrateResult {
  from: string;
  files: number;
  copied: number;
  failed: string[];
}

export async function migrateFromMachine(onProgress?: (done: number, total: number) => void): Promise<MigrateResult> {
  if (storeBackend() !== "database") throw new Error("DATABASE_URL isn't set: nothing to migrate into");
  const vmName = process.env.STORE_VM || "box5";
  const vm = getVms().find((v) => v.name === vmName);
  if (!vm) throw new Error(`${vmName} is not in VMS`);

  // one SSH connection for the listing and every read (the gateway drops bursts of parallel connections)
  return withVm(vm, async (c) => {
    const ls = await run(c, `cd "$HOME/.hosting/store" 2>/dev/null && find . -type f ! -name '*.tmp.*' -printf '%P\\t%s\\n' || true`, { timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 });
    const list = ls.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [path, size] = l.split("\t");
        return { path, size: Number(size) };
      })
      .filter((f) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(f.path) && !f.path.includes(".."));
    const result: MigrateResult = { from: vmName, files: list.length, copied: 0, failed: [] };
    for (const f of list) {
      try {
        const r = await run(c, `base64 -w0 < "$HOME/.hosting/store/${f.path}"`, { timeoutMs: 60_000, maxBytes: Math.ceil(f.size * 1.4) + 1024 });
        if (r.code !== 0) throw new Error(r.stderr.trim());
        const data = Buffer.from(r.stdout.trim(), "base64");
        if (data.length !== f.size) throw new Error(`read ${data.length} of ${f.size} bytes`);
        await storePut(f.path, data);
        const back = await storeGet(f.path, 64 * 1024 * 1024);
        if (!back || !back.equals(data)) throw new Error("verify failed");
        result.copied++;
      } catch (e) {
        result.failed.push(`${f.path}: ${(e as Error).message}`);
      }
      onProgress?.(result.copied + result.failed.length, list.length);
    }
    return result;
  });
}

/** On a fresh database, bring the data over from the storage machine once (in the background). */
export async function autoMigrate(): Promise<void> {
  if (storeBackend() !== "database" || process.env.MIGRATE_FROM_MACHINE === "0") return;
  if ((await storeRowCount()) > 0) return;
  console.log(`[store] empty database: copying the dashboard's data from ${process.env.STORE_VM || "box5"}…`);
  const r = await migrateFromMachine();
  console.log(`[store] copied ${r.copied}/${r.files} files from ${r.from}${r.failed.length ? `; failed: ${r.failed.join("; ")}` : ""}`);
}
