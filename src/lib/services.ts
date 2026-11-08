// Creating a service from the catalog: name, machine, port and passwords are chosen here; database
// tools are created already connected to their database (on the same machine when possible).
import { fillGenerated, PROJECT_NAME_RE, probe, saveProject, startDeploy } from "./agent";
import { engineFromStart, template, type DbEngine } from "./catalog";
import { getVm, getVms, type VmConfig } from "./config";
import { planConnection } from "./connections";
import { rankMachines } from "./placement";
import { mapLimit, withVm } from "./ssh";
import type { VmStatus } from "./types";

export interface CreatedService {
  name: string;
  vm: string;
  jobId: string;
  port: number;
  notes: string[];
}

export async function createService(opts: { template: string; name?: string; vm?: string; connectTo?: string }): Promise<CreatedService> {
  const t = template(opts.template);
  if (!t) throw new Error(`unknown service ${opts.template}`);
  const all = getVms();
  const st: Record<string, VmStatus> = Object.fromEntries((await mapLimit(all, 12, (v) => probe(v, 9_999_999_999))).map((s) => [s.name, s]));
  const projects = all.flatMap((v) => (st[v.name]?.agent?.projects ?? []).map((p) => ({ vm: v.name, m: p.manifest })));
  const notes: string[] = [];

  // a name nobody uses yet
  let name = (opts.name || t.id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || t.id;
  if (!PROJECT_NAME_RE.test(name)) throw new Error("name: lowercase letters, digits and dashes");
  if (!opts.name) for (let i = 2; projects.some((p) => p.m.name === name); i++) name = `${t.id}-${i}`;
  else if (projects.some((p) => p.m.name === name)) throw new Error(`${name} already exists`);

  // the database a tool should point at
  let target: { vm: string; name: string } | null = null;
  if (t.connects) {
    const dbs = projects.filter((p) => p.m.category === "database" && t.connects!.engines.includes(engineFromStart(p.m.start) as DbEngine));
    const pick = opts.connectTo ? dbs.find((d) => d.m.name === opts.connectTo) : dbs[0];
    if (opts.connectTo && !pick) throw new Error(`no ${t.connects.engines.join("/")} database called ${opts.connectTo}`);
    if (pick) target = { vm: pick.vm, name: pick.m.name };
    else notes.push(`no ${t.connects.engines.join(" or ")} database yet: add one, then connect it on the Pipeline`);
  }

  // where: the user's choice, next to its database, or the machine with the most room
  const vmName =
    opts.vm ??
    target?.vm ??
    rankMachines(
      all.map((v) => v.name),
      st,
      t.type === "database" ? "database" : t.type === "tool" ? "tool" : "service",
      process.env.STORE_VM || "box5",
    )[0];
  const vm: VmConfig | undefined = vmName ? getVm(vmName) : undefined;
  if (!vm || !st[vm.name]?.ok) throw new Error(vmName ? `${vmName} isn't reachable right now` : "no machine is reachable right now");

  // a free port on that machine
  const taken = new Set((st[vm.name]?.agent?.projects ?? []).map((p) => p.manifest.port).filter(Boolean));
  let port = t.port;
  while (taken.has(port) || (t.id === "minio" && taken.has(port + 1))) port += t.id === "minio" ? 2 : 1;
  if (port !== t.port) notes.push(`port ${t.port} was taken on ${vm.name}, using ${port}`);

  let env = fillGenerated({ ...t.env }) ?? {};
  let uses: { name: string; env: string; keys: string[] }[] | undefined;
  if (target) {
    const plan = await planConnection([vm], [], target.name, t.connects?.env);
    env = { ...env, ...(await plan.envFor(vm)) };
    uses = [plan.link];
    notes.push(`connected to ${target.name}`, ...plan.notes);
  }

  const fill = (s: string) => s.replaceAll("{name}", name);
  const jobId = await withVm(vm, async (c) => {
    await saveProject(c, {
      name,
      repo: "",
      branch: "main",
      install: fill(t.install),
      build: fill(t.build),
      start: fill(t.start),
      port,
      publish: t.link !== "none",
      access: t.link === "public" ? "public" : "private",
      category: t.type === "database" ? "database" : t.type === "tool" ? "tool" : "app",
      kind: t.type === "service" || t.type === "website" ? t.type : undefined,
      framework: t.name,
      template: t.id,
      uses,
      env,
    });
    return startDeploy(c, name);
  });
  return { name, vm: vm.name, jobId, port, notes };
}
