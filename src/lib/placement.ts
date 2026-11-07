// Where a new project should run, when the user doesn't say. Shared by the New project form and the Assistant.
import type { VmStatus } from "./types";

export type PlaceKind = "website" | "service" | "worker" | "database" | "tool" | "app";

/**
 * Online machines, best first. Apps go where there is the most free memory and disk and the fewest
 * projects; databases stay together on the database machine (the one that already has databases,
 * or the preferred storage machine).
 */
export function rankMachines(names: string[], status: Record<string, VmStatus | undefined>, kind: PlaceKind, preferDb?: string): string[] {
  const scored = names
    .filter((n) => status[n]?.ok && status[n]?.agent)
    .map((n) => {
      const a = status[n]!.agent!;
      const memFreeGb = a.memAvailKb / 1048576;
      const diskFreeGb = (a.diskTotalKb - a.diskUsedKb) / 1048576;
      const dbs = a.projects.filter((p) => p.manifest.category === "database").length;
      const apps = a.projects.length - dbs;
      let score = memFreeGb * 2 + diskFreeGb * 0.4 - apps * 1.5 - a.cpuPct / 25;
      if (kind === "database") score += dbs * 50 + (n === preferDb ? 40 : 0);
      else score -= dbs * 3 + (n === preferDb ? 4 : 0); // keep apps off the database machine when there's a choice
      if (diskFreeGb < 2) score -= 100;
      return { n, score };
    });
  return scored.sort((x, y) => y.score - x.score).map((x) => x.n);
}
