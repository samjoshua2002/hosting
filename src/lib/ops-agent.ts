// The AI SRE agent: reads the fleet through fixed, read-only diagnostics and proposes changes for a human to approve.
import { chat, type ChatMessage, type ToolDef } from "./ai";
import { probe } from "./agent";
import { getVm, getVms } from "./config";
import { mapLimit, run, withVm } from "./ssh";

const HOSTCTL = '"$HOME/.hosting/bin/hostctl"';

/** Fixed commands only: the model picks a name, never writes shell. All are read-only. */
const CHECKS: Record<string, string> = {
  overview: "hostname; uptime; echo; df -h / ~ 2>/dev/null; echo; free -m",
  disk: "df -h; echo; du -xsh ~/* ~/.[!.]* 2>/dev/null | sort -rh | head -15; echo; docker system df 2>/dev/null",
  memory: "free -m; echo; ps -eo pid,user,%mem,rss,etime,comm --sort=-%mem | head -15",
  cpu: "uptime; echo; ps -eo pid,user,%cpu,etime,comm --sort=-%cpu | head -15",
  ports: "ss -ltnp 2>/dev/null | head -40",
  docker:
    "docker ps -a --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>&1 | head -30; echo; docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}' 2>&1 | head -20",
  services: "systemctl --user list-units 'hosting-*' --all --no-pager 2>&1 | head -40; echo; systemctl --user --failed --no-pager 2>&1 | head -20",
  errors: "(journalctl -p err -n 40 --no-pager 2>/dev/null || sudo -n journalctl -p err -n 40 --no-pager 2>&1) | tail -40",
  network: "ip -brief addr 2>/dev/null; echo; ss -s 2>/dev/null; echo; head -5 /etc/resolv.conf 2>/dev/null",
  security: "whoami; id; echo; ss -ltn 2>/dev/null | head -20; echo; ls -la ~/.ssh 2>/dev/null; echo; last -n 5 2>/dev/null | head -8",
  updates: "apt list --upgradable 2>/dev/null | head -25",
};

const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Proposal {
  id: string;
  title: string;
  why: string;
  command: string;
  targets: string[];
  risk: "low" | "medium" | "high";
  background: boolean;
}

export interface Step {
  tool: string;
  label: string;
  ok: boolean;
}

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "fleet_status",
      description: "Live health of every VM: reachability, CPU, memory, disk, load, projects (systemd services) and running jobs.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_vm",
      description:
        "Run one read-only diagnostic on one VM and get its output. checks: " +
        Object.keys(CHECKS).join(", ") +
        ", project_logs (needs project).",
      parameters: {
        type: "object",
        properties: {
          vm: { type: "string", description: "VM name, e.g. box1" },
          check: { type: "string", enum: [...Object.keys(CHECKS), "project_logs"] },
          project: { type: "string", description: "Project name, for project_logs" },
        },
        required: ["vm", "check"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_action",
      description:
        "Suggest a shell command for the operator to approve. It is NOT run by you. Use for any change (restart, cleanup, install, deploy). One clear command per proposal.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short imperative, e.g. 'Free Docker build cache on box2'" },
          why: { type: "string", description: "One or two sentences of evidence and expected effect" },
          command: { type: "string", description: "Bash run as the VM user (sudo available)" },
          targets: { type: "array", items: { type: "string" }, description: "VM names" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          background: { type: "boolean", description: "true for anything that may take over a minute" },
        },
        required: ["title", "why", "command", "targets", "risk"],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM = `You are the on-call SRE agent for a small fleet of Linux VMs managed from a web dashboard.
Facts about the fleet:
- VMs are InstaBox sandboxes (Debian 13, 4 vCPU, 8 GB RAM, 20 GB disk) reached over SSH. Free plan: each auto-pauses after 30 min idle and stops after 2 h of continuous running, then a 5-20 min cooldown (longer when repeated). An "unreachable" VM is usually paused or cooling down, not broken.
- Each VM runs the "hostctl" agent. Deployed projects are systemd --user services named hosting-<project>, code in ~/apps/<project>, logs in ~/.hosting/projects/<project>.log, public URLs via "instabox-port publish <port>".
- The operator can run commands on any VM from the dashboard; sudo works without a password.
How you work:
- Gather evidence with fleet_status and inspect_vm before concluding. Don't guess numbers.
- You never change anything yourself. Every command you recommend MUST be submitted with the propose_action tool (the operator only gets an "Approve & run" button for proposals made through the tool; commands written only in your text are lost). One exact, safe command per proposal; prefer reversible steps; mark anything destructive as risk "high" and say what it deletes. In your text, refer to proposals briefly instead of repeating the command.
- Answer like a senior engineer in a production incident: lead with the verdict, then evidence (short bullets with real numbers), then recommended actions. Be concise. Use markdown sparingly (bullets, inline code).`;

async function fleetStatus(): Promise<string> {
  const results = await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999));
  return JSON.stringify(
    results.map((s) => {
      const a = s.agent;
      if (!s.ok || !a) return { vm: s.name, reachable: false, error: s.error };
      return {
        vm: s.name,
        reachable: true,
        cpuPct: a.cpuPct,
        load: a.load,
        cores: a.cores,
        memUsedPct: Math.round(((a.memTotalKb - a.memAvailKb) * 100) / a.memTotalKb),
        memFreeMB: Math.round(a.memAvailKb / 1024),
        diskUsedPct: Math.round((a.diskUsedKb * 100) / a.diskTotalKb),
        diskFreeGB: +((a.diskTotalKb - a.diskUsedKb) / 1048576).toFixed(1),
        uptimeMin: Math.round(a.uptimeSec / 60),
        docker: a.docker,
        projects: a.projects.map((p) => ({ name: p.manifest.name, state: p.active, port: p.manifest.port })),
        publicUrls: a.ports.map((p) => p.url),
        jobsRunning: a.jobs.filter((j) => j.state === "running").map((j) => j.meta.label),
      };
    }),
  );
}

async function inspect(args: { vm?: string; check?: string; project?: string }): Promise<string> {
  const vm = args.vm ? getVm(args.vm) : undefined;
  if (!vm) return `Unknown VM "${args.vm}". Known: ${getVms().map((v) => v.name).join(", ")}`;
  let cmd: string;
  if (args.check === "project_logs") {
    if (!args.project || !PROJECT_RE.test(args.project)) return "project_logs needs a valid project name";
    cmd = `${HOSTCTL} project logs ${args.project} 120`;
  } else if (args.check && CHECKS[args.check]) {
    cmd = CHECKS[args.check];
  } else return `Unknown check "${args.check}"`;
  try {
    const out = await withVm(vm, (conn) => run(conn, cmd, { timeoutMs: 20_000, maxBytes: 64 * 1024 }));
    const text = (out.stdout + (out.stderr ? `\n[stderr]\n${out.stderr}` : "")).trim();
    return text.length > 6000 ? `${text.slice(0, 6000)}\n…(truncated)` : text || "(no output)";
  } catch (e) {
    return `Could not reach ${vm.name}: ${(e as Error).message}`;
  }
}

export async function runAgent(history: { role: "user" | "assistant"; content: string }[], model?: string) {
  const started = Date.now();
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }, ...history.slice(-12)];
  const steps: Step[] = [];
  const proposals: Proposal[] = [];
  let usedModel = model ?? "";

  for (let round = 0; round < 8; round++) {
    const outOfTime = Date.now() - started > 150_000;
    const res = await chat({ model, messages, tools: TOOLS, toolChoice: outOfTime ? "none" : "auto", maxTokens: 3000 });
    usedModel = res.model;
    const msg = res.message;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) return { reply: msg.content ?? "", steps, proposals, model: usedModel };

    const outputs = await Promise.all(
      msg.tool_calls.map(async (call) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
        let content: string;
        if (call.function.name === "fleet_status") {
          content = await fleetStatus();
          steps.push({ tool: "fleet_status", label: "Checked fleet health", ok: true });
        } else if (call.function.name === "inspect_vm") {
          content = await inspect(args as { vm?: string; check?: string; project?: string });
          steps.push({
            tool: "inspect_vm",
            label: `Inspected ${String(args.check)}${args.project ? ` (${String(args.project)})` : ""} on ${String(args.vm)}`,
            ok: !content.startsWith("Could not") && !content.startsWith("Unknown"),
          });
        } else if (call.function.name === "propose_action") {
          const targets = (Array.isArray(args.targets) ? args.targets : []).filter((t): t is string => typeof t === "string" && Boolean(getVm(t)));
          const command = typeof args.command === "string" ? args.command.trim() : "";
          if (!command || !targets.length) {
            content = "Rejected: needs a command and at least one known VM.";
          } else {
            proposals.push({
              id: `p${proposals.length + 1}-${Date.now().toString(36)}`,
              title: String(args.title ?? "Proposed action").slice(0, 120),
              why: String(args.why ?? "").slice(0, 600),
              command: command.slice(0, 4000),
              targets,
              risk: args.risk === "high" || args.risk === "medium" ? args.risk : "low",
              background: Boolean(args.background),
            });
            content = "Recorded. The operator will review and run it if they approve.";
          }
        } else {
          content = `Unknown tool ${call.function.name}`;
        }
        return { role: "tool" as const, tool_call_id: call.id, content };
      }),
    );
    messages.push(...outputs);
  }
  const final = await chat({ model, messages, tools: TOOLS, toolChoice: "none", maxTokens: 2000 });
  return { reply: final.message.content ?? "", steps, proposals, model: final.model };
}
