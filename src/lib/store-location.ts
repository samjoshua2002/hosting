// Which of the user's machines holds the dashboard's data, and what happens when it rests.
//
// - One machine is the storage machine (STORE_VM at first, box5). Every machine keeps a tiny pointer file
//   (~/.hosting/store-pointer: "<machine> <epoch>") naming it, so the choice survives a resting storage machine
//   and server restarts: the highest epoch among reachable machines wins.
// - Each Autopilot pass copies the data to a second machine (mirrorStore), so there's always a recent copy.
// - If the storage machine is unreachable, store calls fail with StoreDownError (when it's back, if InstaBox
//   said, and where the latest copy is). The user then waits, or switches storage to the copy (switchStore).
import { getVm, getVms, type VmConfig } from "./config";
import { mapLimit, run, withVm } from "./ssh";

const POINTER = '"$HOME/.hosting/store-pointer"';
const STORE_DIR = '"$HOME/.hosting/store"';
const CACHE_MS = 10 * 60_000;

export interface StoreCopy {
  vm: string;
  /** when the copy was made (ms) */
  at: number;
  from: string;
}

export class StoreDownError extends Error {
  constructor(
    public vm: string,
    public until: string | null,
    public backup: StoreCopy | null,
  ) {
    super(
      `The storage machine ${vm} is ${until ? `cooling down until ${new Date(until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC` : "unreachable right now"}.` +
        (backup ? ` Wait for it, or switch storage to ${backup.vm} (copy from ${Math.max(1, Math.round((Date.now() - backup.at) / 60_000))} min ago).` : " Wait for it to come back."),
    );
  }
}

let active: { vm: string; epoch: number; checked: number } | null = null;

/** SSH errors that mean "the machine isn't there", not "the command failed". */
export function isUnreachable(e: unknown): boolean {
  return /cooling down|Channel open failure|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|handshake|Timed out|not reachable|unreachable/i.test((e as Error)?.message ?? "");
}
function untilOf(e: unknown): string | null {
  return (e as Error)?.message?.match(/until (\d{4}-\d\d-\d\dT[\d:.]+Z)/)?.[1] ?? null;
}

interface Seen {
  vm: string;
  pointer: { vm: string; epoch: number } | null;
  copy: StoreCopy | null;
  hasStore: boolean;
}

/** Ask every reachable machine for its pointer and whether it holds a copy. */
async function scan(): Promise<Seen[]> {
  const res = await mapLimit(getVms(), 8, async (vm) => {
    try {
      const r = await withVm(vm, (c) =>
        run(c, `cat ${POINTER} 2>/dev/null; echo; echo "#copy $(cat ${STORE_DIR}/.mirror 2>/dev/null)"; [ -d ${STORE_DIR} ] && echo "#store yes"`, { timeoutMs: 15_000 }),
      );
      const lines = r.stdout.split("\n");
      const p = lines[0]?.trim().match(/^([a-z0-9][a-z0-9-]{0,31}) (\d+)$/);
      const m = r.stdout.match(/#copy (\{.*\})/);
      let copy: StoreCopy | null = null;
      try {
        copy = m ? (JSON.parse(m[1]) as StoreCopy) : null;
      } catch {
        /* ignore */
      }
      return { vm: vm.name, pointer: p ? { vm: p[1], epoch: Number(p[2]) } : null, copy, hasStore: /#store yes/.test(r.stdout) } as Seen;
    } catch {
      return null;
    }
  });
  return res.filter((x): x is Seen => x !== null);
}

/** The storage machine now (cached for a few minutes). */
export async function activeStoreVm(): Promise<VmConfig> {
  if (active && Date.now() - active.checked < CACHE_MS) {
    const vm = getVm(active.vm);
    if (vm) return vm;
  }
  const seen = await scan();
  const best = seen.map((s) => s.pointer).filter((p): p is { vm: string; epoch: number } => Boolean(p && getVm(p.vm))).sort((a, b) => b.epoch - a.epoch)[0];
  const name = best?.vm ?? process.env.STORE_VM ?? "box5";
  active = { vm: name, epoch: best?.epoch ?? 0, checked: Date.now() };
  const vm = getVm(name);
  if (!vm) throw new Error(`storage machine ${name} is not in the machine list`);
  return vm;
}

/** The newest copy on a reachable machine other than the storage machine. */
export async function latestCopy(exclude?: string): Promise<StoreCopy | null> {
  const seen = await scan();
  return (
    seen
      .filter((s) => s.copy && s.vm !== exclude)
      .map((s) => ({ ...s.copy!, vm: s.vm }))
      .sort((a, b) => b.at - a.at)[0] ?? null
  );
}

/**
 * Run fn on the storage machine. If it can't be reached, throw StoreDownError with when it's back and
 * where the latest copy is, so the UI can offer the choice.
 */
export async function withStore<T>(fn: Parameters<typeof withVm<T>>[1]): Promise<T> {
  const vm = await activeStoreVm();
  try {
    return await withVm(vm, fn);
  } catch (e) {
    if (!isUnreachable(e)) throw e;
    if (active) active.checked = 0; // look again next time (maybe storage was switched elsewhere)
    throw new StoreDownError(vm.name, untilOf(e), await latestCopy(vm.name).catch(() => null));
  }
}

/** Where things stand, for the UI (works while the storage machine is down). */
export async function storeStatus(): Promise<{ vm: string; ok: boolean; until: string | null; copy: StoreCopy | null }> {
  const vm = await activeStoreVm();
  try {
    await withVm(vm, (c) => run(c, "true", { timeoutMs: 15_000 }));
    return { vm: vm.name, ok: true, until: null, copy: await latestCopy(vm.name).catch(() => null) };
  } catch (e) {
    return { vm: vm.name, ok: false, until: untilOf(e), copy: await latestCopy(vm.name).catch(() => null) };
  }
}

/** Point every reachable machine at the storage machine (epoch: newer wins). */
async function writePointers(vmName: string, epoch: number): Promise<number> {
  const ok = await mapLimit(getVms(), 8, (vm) =>
    withVm(vm, (c) => run(c, `mkdir -p "$HOME/.hosting" && printf '%s %s\\n' ${vmName} ${epoch} > ${POINTER}.tmp && mv -f ${POINTER}.tmp ${POINTER}`, { timeoutMs: 15_000 }))
      .then(() => true)
      .catch(() => false),
  );
  return ok.filter(Boolean).length;
}

/** Make <to> the storage machine (it must hold a copy). The user chose this while the old one was resting. */
export async function switchStore(to: string): Promise<{ vm: string; copyAt: number | null; pointers: number }> {
  const target = getVm(to);
  if (!target) throw new Error(`${to} is not in the machine list`);
  const seen = await scan();
  const here = seen.find((s) => s.vm === to);
  if (!here) throw new Error(`${to} isn't reachable right now`);
  if (!here.hasStore) throw new Error(`${to} has no copy of the dashboard's data yet`);
  const epoch = Date.now();
  // the copy becomes the real thing: drop its "copy" label so the next mirror pass treats it as the source
  await withVm(target, (c) => run(c, `rm -f ${STORE_DIR}/.mirror`, { timeoutMs: 15_000 }));
  const pointers = await writePointers(to, epoch);
  active = { vm: to, epoch, checked: Date.now() };
  return { vm: to, copyAt: here.copy?.at ?? null, pointers };
}

/**
 * Copy the storage machine's data to a second machine (one Autopilot step). The target's previous contents
 * are kept once as store.prev, so a machine that comes back with newer data never loses it silently.
 */
export async function mirrorStore(fleetOk: string[]): Promise<StoreCopy | null> {
  const src = await activeStoreVm();
  if (!fleetOk.includes(src.name)) return null;
  // keep everyone pointing at the current storage machine (new machines, reset ones)
  await writePointers(src.name, active?.epoch ?? 0);
  const seen = await scan();
  const candidates = seen.filter((s) => s.vm !== src.name && fleetOk.includes(s.vm));
  if (!candidates.length) return null;
  // the machine that already holds our copy, else the first other reachable one
  const target = candidates.find((s) => s.copy?.from === src.name) ?? candidates[0];
  const tvm = getVm(target.vm)!;

  const tar = await withVm(src, (c) => run(c, `tar czf - -C "$HOME/.hosting" --exclude='store/.mirror' --exclude='*.tmp.*' store | base64 -w0`, { timeoutMs: 120_000, maxBytes: 80 * 1024 * 1024 }));
  if (tar.code !== 0 || tar.truncated) throw new Error(`couldn't read the data on ${src.name}: ${tar.stderr.trim().slice(0, 160) || "too large"}`);
  const copy: StoreCopy = { vm: tvm.name, at: Date.now(), from: src.name };
  const meta = Buffer.from(JSON.stringify(copy)).toString("base64");
  const w = await withVm(tvm, (c) =>
    run(
      c,
      `set -e; umask 077; H="$HOME/.hosting"; rm -rf "$H/store.new"; mkdir -p "$H/store.new"; base64 -d | tar xzf - -C "$H/store.new"; ` +
        `echo ${meta} | base64 -d > "$H/store.new/store/.mirror"; ` +
        `if [ -d "$H/store" ] && [ ! -f "$H/store/.mirror" ]; then rm -rf "$H/store.prev"; mv "$H/store" "$H/store.prev"; else rm -rf "$H/store"; fi; ` +
        `mv "$H/store.new/store" "$H/store"; rm -rf "$H/store.new"; echo ok`,
      { stdin: tar.stdout, timeoutMs: 120_000 },
    ),
  );
  if (!w.stdout.includes("ok")) throw new Error(`couldn't write the copy on ${tvm.name}: ${w.stderr.trim().slice(0, 160)}`);
  return copy;
}
