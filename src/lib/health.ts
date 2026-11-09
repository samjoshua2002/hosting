import type { MailItem } from "./mail";
import type { VmStatus } from "./types";

export const THRESHOLDS = { disk: 85, memory: 90, cpu: 95 };

/** Problems worth an alert. Unreachable VMs are "warning": on InstaBox that is usually sleep/cooldown. */
export function findProblems(statuses: VmStatus[]): MailItem[] {
  const items: MailItem[] = [];
  for (const s of statuses) {
    const a = s.agent;
    if (!s.ok || !a) {
      items.push({ tone: "warning", title: `${s.name} unreachable`, detail: s.error ?? "no response" });
      continue;
    }
    const disk = Math.round((a.diskUsedKb * 100) / a.diskTotalKb);
    const mem = Math.round(((a.memTotalKb - a.memAvailKb) * 100) / a.memTotalKb);
    if (disk >= THRESHOLDS.disk) items.push({ tone: "critical", title: `${s.name} disk ${disk}% full`, detail: `${((a.diskTotalKb - a.diskUsedKb) / 1048576).toFixed(1)} GB left` });
    if (mem >= THRESHOLDS.memory) items.push({ tone: "critical", title: `${s.name} memory ${mem}% used`, detail: `${Math.round(a.memAvailKb / 1024)} MB available` });
    if (a.cpuPct >= THRESHOLDS.cpu) items.push({ tone: "warning", title: `${s.name} CPU at ${a.cpuPct}%`, detail: `load ${a.load.join(" ")}` });
    for (const p of a.projects)
      if (p.active === "failed") items.push({ tone: "critical", title: `${p.manifest.name} failed on ${s.name}`, detail: "The service crashed and systemd gave up restarting it." });
  }
  return items;
}

/** What Investigate sends the Assistant: the problems, plus how to treat each kind. */
export function investigatePrompt(problems: MailItem[]): string {
  const list = problems.map((p) => `- ${p.title}${p.detail ? ` (${p.detail})` : ""}`).join("\n");
  return [
    `Investigate ${problems.length === 1 ? "this problem" : `these ${problems.length} problems`} on my fleet and fix what you safely can:`,
    list,
    "",
    "A machine that is \"cooling down\" is InstaBox resting it (usage limit), not a fault: say when it comes back and whether anything that runs only there is down meanwhile.",
    "For a full disk, find what is using the space (du, docker system df, old logs, caches) and free what is safe; ask me before deleting anything that isn't a cache, log or unused image.",
    "End with a short summary: what you fixed, what still needs me.",
  ].join("\n");
}
