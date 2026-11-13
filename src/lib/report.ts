// The fleet report: one professional email every few hours (REPORT_EVERY_HOURS, default 5) instead of an alert per
// check. Autopilot and the dashboard only log what they see; the report gathers the period (machines, what
// Autopilot fixed, what still needs you, deploys, Assistant activity), has the AI write an executive summary, and
// sends it once.
import { probe } from "./agent";
import { aiConfigured, chat } from "./ai";
import { getVms } from "./config";
import { mailConfigured, sendMail } from "./mail";
import { listSessions } from "./sessions";
import { mapLimit } from "./ssh";
import { storeGetJson, storePut } from "./store";
import type { VmStatus } from "./types";

const EVENTS = "reports/events.json";
const STATE = "reports/state.json";
const KEEP_MS = 3 * 24 * 3600_000;

export type ReportEvent = { at: number; kind: "fixed" | "problem" | "notice"; text: string };
interface ReportState {
  lastSentAt?: number;
  claimedAt?: number;
  lastSubject?: string;
}

export const reportEveryMs = () => Math.max(1, Number(process.env.REPORT_EVERY_HOURS) || 5) * 3600_000;

/** Routine housekeeping that isn't news on its own (still counted in the report). */
const ROUTINE = /kept a copy of the dashboard's data/i;

/** Remember what was seen; the next report tells it. Never throws. */
export async function logEvents(events: Omit<ReportEvent, "at">[]): Promise<void> {
  if (!events.length) return;
  try {
    const now = Date.now();
    const old = (await storeGetJson<ReportEvent[]>(EVENTS)) ?? [];
    const next = [...old.filter((e) => now - e.at < KEEP_MS), ...events.map((e) => ({ ...e, text: e.text.slice(0, 400), at: now }))].slice(-1500);
    await storePut(EVENTS, JSON.stringify(next));
  } catch {
    /* the report is best-effort; checks must not fail because of it */
  }
}

/* ---------------- gathering ---------------- */

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const gb = (kb: number) => `${(kb / 1024 / 1024).toFixed(1)} GB`;

interface Period {
  from: number;
  to: number;
  machines: { name: string; up: boolean; cpu: number; mem: number; disk: number; projects: number; crashed: string[]; detail: string }[];
  fixed: { text: string; count: number }[];
  problems: { text: string; count: number }[];
  routine: number;
  deploys: { project: string; vm: string; ok: boolean | null; at: number }[];
  chats: { title: string; at: number }[];
}

function tally(list: ReportEvent[]): { text: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of list) m.set(e.text, (m.get(e.text) ?? 0) + 1);
  return [...m.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
}

async function gather(from: number, to: number, fleet?: VmStatus[]): Promise<Period> {
  const statuses = fleet ?? (await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999)));
  const events = ((await storeGetJson<ReportEvent[]>(EVENTS).catch(() => null)) ?? []).filter((e) => e.at >= from && e.at <= to);
  const sessions = await listSessions().catch(() => []);
  const machines = statuses.map((s) => {
    const a = s.agent;
    return {
      name: s.name,
      up: s.ok,
      cpu: a ? Math.round(a.cpuPct) : 0,
      mem: a ? pct(a.memTotalKb - a.memAvailKb, a.memTotalKb) : 0,
      disk: a ? pct(a.diskUsedKb, a.diskTotalKb) : 0,
      projects: a?.projects.length ?? 0,
      crashed: a?.projects.filter((p) => p.active === "failed").map((p) => p.manifest.name) ?? [],
      detail: a ? `${a.cores} vCPU · ${gb(a.memTotalKb)} RAM · ${gb(a.diskTotalKb - a.diskUsedKb)} free disk` : (s.error ?? "not answering (resting or cooling down)").slice(0, 120),
    };
  });
  const deploys = statuses
    .flatMap((s) =>
      (s.agent?.jobs ?? [])
        .filter((j) => j.meta.kind === "deploy" && j.meta.startedAt * 1000 >= from)
        .map((j) => ({ project: j.meta.project ?? j.meta.label, vm: s.name, ok: j.state === "done" ? j.exitCode === 0 : null, at: j.meta.startedAt * 1000 })),
    )
    .sort((a, b) => b.at - a.at);
  return {
    from,
    to,
    machines,
    fixed: tally(events.filter((e) => e.kind === "fixed" && !ROUTINE.test(e.text))),
    problems: tally(events.filter((e) => e.kind !== "fixed")),
    routine: events.filter((e) => ROUTINE.test(e.text)).length,
    deploys,
    chats: sessions.filter((s) => s.updatedAt >= from && s.updatedAt <= to).map((s) => ({ title: s.title, at: s.updatedAt })),
  };
}

/* ---------------- the AI's summary ---------------- */

interface Summary {
  status: "healthy" | "attention" | "incident";
  headline: string;
  summary: string;
  highlights: string[];
  next: string[];
}

function plainSummary(p: Period): Summary {
  const down = p.machines.filter((m) => !m.up).length;
  const crashed = p.machines.flatMap((m) => m.crashed).length;
  const status: Summary["status"] = crashed || p.problems.length > 3 ? "incident" : down || p.problems.length ? "attention" : "healthy";
  return {
    status,
    headline: status === "healthy" ? "All systems healthy" : `${down ? `${down} machine${down > 1 ? "s" : ""} resting` : ""}${down && p.problems.length ? ", " : ""}${p.problems.length ? `${p.problems.length} open issue${p.problems.length > 1 ? "s" : ""}` : ""}`,
    summary: `${p.machines.length - down} of ${p.machines.length} machines answered. Autopilot made ${p.fixed.reduce((a, f) => a + f.count, 0)} fix(es) and ${p.deploys.length} deploy(s) ran in this period.`,
    highlights: [],
    next: p.problems.slice(0, 3).map((x) => `Look at: ${x.text}`),
  };
}

async function aiSummary(p: Period): Promise<Summary> {
  if (!aiConfigured()) return plainSummary(p);
  try {
    const res = await chat({
      json: true,
      maxTokens: 1500,
      timeoutMs: 60_000,
      messages: [
        {
          role: "system",
          content:
            "You are the operations lead writing a short report on a small self-hosted fleet (InstaBox VMs; a machine that is not answering is usually resting/cooling down, not broken). " +
            "Write for the owner, plainly and specifically: name machines and projects, give numbers, no filler, no hype, no emoji. " +
            'Return JSON: {"status":"healthy|attention|incident","headline":"≤8 words","summary":"2-3 sentences: overall state and what changed in this period","highlights":["≤4 notable things, each one sentence"],"next":["≤3 concrete next steps for the owner, most important first; empty if nothing is needed"]}',
        },
        { role: "user", content: JSON.stringify({ period: { from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString() }, ...p }) },
      ],
    });
    const j = JSON.parse(res.message.content ?? "{}") as Partial<Summary>;
    const base = plainSummary(p);
    return {
      status: j.status === "healthy" || j.status === "attention" || j.status === "incident" ? j.status : base.status,
      headline: String(j.headline || base.headline).slice(0, 80),
      summary: String(j.summary || base.summary).slice(0, 700),
      highlights: (Array.isArray(j.highlights) ? j.highlights : []).map(String).slice(0, 4),
      next: (Array.isArray(j.next) ? j.next : base.next).map(String).slice(0, 3),
    };
  } catch {
    return plainSummary(p);
  }
}

/* ---------------- the email ---------------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: process.env.REPORT_TIMEZONE || "Asia/Kolkata" });
const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: process.env.REPORT_TIMEZONE || "Asia/Kolkata" });

export function renderHtml(p: Period, s: Summary): string {
  const tone = { healthy: ["#0f7b3e", "#e8f6ee", "Healthy"], attention: ["#9a6200", "#fff5e0", "Needs attention"], incident: ["#b42318", "#fdecea", "Incident"] }[s.status];
  const app = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const section = (title: string, body: string) =>
    body ? `<tr><td style="padding:22px 32px 0"><p style="margin:0 0 10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;font-weight:600">${title}</p>${body}</td></tr>` : "";
  const list = (items: string[]) => (items.length ? `<ul style="margin:0;padding-left:18px;color:#27272a;font-size:14px;line-height:1.6">${items.map((i) => `<li style="margin:2px 0">${i}</li>`).join("")}</ul>` : "");
  const bar = (v: number) => {
    const c = v >= 90 ? "#b42318" : v >= 75 ? "#c27803" : "#3f3f46";
    return `<span style="color:${c};font-variant-numeric:tabular-nums">${v}%</span>`;
  };
  const machines = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
    <tr style="color:#71717a;text-align:left"><th style="padding:6px 0;font-weight:500">Machine</th><th style="font-weight:500">Status</th><th style="font-weight:500;text-align:right">CPU</th><th style="font-weight:500;text-align:right">Mem</th><th style="font-weight:500;text-align:right">Disk</th><th style="font-weight:500;text-align:right">Apps</th></tr>
    ${p.machines
      .map(
        (m) => `<tr style="border-top:1px solid #f0f0f2">
      <td style="padding:8px 0;color:#18181b;font-weight:600">${esc(m.name)}<div style="font-weight:400;color:#a1a1aa;font-size:11.5px">${esc(m.detail)}</div></td>
      <td style="color:${m.up ? (m.crashed.length ? "#b42318" : "#0f7b3e") : "#9a6200"}">${m.up ? (m.crashed.length ? `${m.crashed.length} crashed` : "Up") : "Resting"}</td>
      <td style="text-align:right">${m.up ? bar(m.cpu) : "–"}</td><td style="text-align:right">${m.up ? bar(m.mem) : "–"}</td><td style="text-align:right">${m.up ? bar(m.disk) : "–"}</td>
      <td style="text-align:right;color:#3f3f46">${m.up ? m.projects : "–"}</td></tr>`,
      )
      .join("")}
  </table>`;
  const times = (n: number) => (n > 1 ? ` <span style="color:#a1a1aa">×${n}</span>` : "");
  const up = p.machines.filter((m) => m.up).length;
  const stat = (label: string, value: string) =>
    `<td style="padding:14px 16px;background:#fafafa;border:1px solid #f0f0f2;border-radius:10px;width:25%"><div style="font-size:22px;font-weight:700;color:#18181b">${value}</div><div style="font-size:12px;color:#71717a;margin-top:2px">${label}</div></td>`;

  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:28px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px;overflow:hidden">
  <tr><td style="padding:28px 32px 0">
    <table role="presentation" width="100%"><tr>
      <td style="font-size:13px;font-weight:600;color:#18181b">hosting <span style="color:#a1a1aa;font-weight:400">· fleet report</span></td>
      <td align="right"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${tone[1]};color:${tone[0]};font-size:12px;font-weight:600">${tone[2]}</span></td>
    </tr></table>
    <h1 style="margin:18px 0 6px;font-size:24px;line-height:1.25;color:#09090b;letter-spacing:-.01em">${esc(s.headline)}</h1>
    <p style="margin:0;color:#71717a;font-size:13px">${esc(fmt(p.from))} – ${esc(time(p.to))}</p>
    <p style="margin:16px 0 0;color:#27272a;font-size:15px;line-height:1.6">${esc(s.summary)}</p>
  </td></tr>
  <tr><td style="padding:20px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate"><tr>
    ${stat("machines up", `${up}/${p.machines.length}`)}${stat("fixed by Autopilot", String(p.fixed.reduce((a, f) => a + f.count, 0)))}${stat("open issues", String(p.problems.length))}${stat("deploys", String(p.deploys.length))}
  </tr></table></td></tr>
  ${section("Highlights", list(s.highlights.map(esc)))}
  ${section("Recommended next steps", list(s.next.map(esc)))}
  ${section("Needs attention", list(p.problems.slice(0, 8).map((x) => esc(x.text) + times(x.count))))}
  ${section("Fixed automatically", list([...p.fixed.slice(0, 8).map((x) => esc(x.text) + times(x.count)), ...(p.routine ? [`Backed up the dashboard's data to a second machine${times(p.routine)}`] : [])]))}
  ${section("Machines now", machines)}
  ${section("Deploys", list(p.deploys.slice(0, 8).map((d) => `${esc(d.project)} on ${esc(d.vm)} · ${d.ok === null ? "running" : d.ok ? '<span style="color:#0f7b3e">succeeded</span>' : '<span style="color:#b42318">failed</span>'} · ${esc(time(d.at))}`)))}
  ${section("Assistant", p.chats.length ? list(p.chats.slice(0, 6).map((c) => `${esc(c.title)} <span style="color:#a1a1aa">· ${esc(time(c.at))}</span>`)) : "")}
  <tr><td style="padding:26px 32px 30px">
    ${app ? `<a href="${esc(app)}" style="display:inline-block;background:#18181b;color:#ffffff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;font-size:13px">Open dashboard</a>` : ""}
    <p style="margin:18px 0 0;color:#a1a1aa;font-size:12px;line-height:1.5">One report every ${Math.round(reportEveryMs() / 3600_000)} hours. Autopilot keeps checking every 15 minutes and fixes what it safely can in between.</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function renderText(p: Period, s: Summary): string {
  return [
    `${s.headline} (${s.status})`,
    `${fmt(p.from)} – ${time(p.to)}`,
    "",
    s.summary,
    ...(s.highlights.length ? ["", "Highlights:", ...s.highlights.map((x) => `- ${x}`)] : []),
    ...(s.next.length ? ["", "Next steps:", ...s.next.map((x) => `- ${x}`)] : []),
    ...(p.problems.length ? ["", "Needs attention:", ...p.problems.slice(0, 8).map((x) => `- ${x.text}${x.count > 1 ? ` (x${x.count})` : ""}`)] : []),
    "",
    "Machines:",
    ...p.machines.map((m) => `- ${m.name}: ${m.up ? `up, CPU ${m.cpu}%, mem ${m.mem}%, disk ${m.disk}%` : "resting"}`),
    "",
    process.env.APP_URL ?? "",
  ].join("\n");
}

/* ---------------- sending ---------------- */

/**
 * Send the report when one is due (or now with force). One sender at a time: the period is claimed in the store
 * before the email goes out, so several machines' checks arriving together still send one email.
 */
export async function maybeSendReport(opts: { force?: boolean; fleet?: VmStatus[] } = {}): Promise<{ sent: boolean; reason?: string; subject?: string }> {
  if (!mailConfigured()) return { sent: false, reason: "email isn't set up" };
  let state: ReportState;
  try {
    state = (await storeGetJson<ReportState>(STATE)) ?? {};
  } catch {
    return { sent: false, reason: "the dashboard's data isn't reachable right now" };
  }
  const now = Date.now();
  const every = reportEveryMs();
  if (!opts.force) {
    if (state.lastSentAt && now - state.lastSentAt < every) return { sent: false, reason: "not due yet" };
    if (state.claimedAt && now - state.claimedAt < 10 * 60_000) return { sent: false, reason: "another check is sending it" };
  }
  try {
    await storePut(STATE, JSON.stringify({ ...state, claimedAt: now }));
  } catch {
    return { sent: false, reason: "couldn't record the report" };
  }
  const from = state.lastSentAt && now - state.lastSentAt < 3 * every ? state.lastSentAt : now - every;
  const period = await gather(from, now, opts.fleet);
  const summary = await aiSummary(period);
  const subject = `${summary.status === "healthy" ? "✓" : summary.status === "incident" ? "●" : "▲"} ${summary.headline} · ${time(from)}–${time(now)}`;
  const sent = await sendMail(subject, renderHtml(period, summary), renderText(period, summary));
  await storePut(STATE, JSON.stringify({ lastSentAt: sent ? now : state.lastSentAt, claimedAt: undefined, lastSubject: sent ? subject : state.lastSubject })).catch(() => {});
  return { sent, subject, reason: sent ? undefined : "the email didn't go out" };
}
