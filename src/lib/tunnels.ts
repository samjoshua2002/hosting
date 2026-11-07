// Private links from app machines to a database machine, through the InstaBox SSH gateway.
// Each app machine runs a systemd --user service holding an SSH local forward, so apps there reach the
// databases at 127.0.0.1:<port> exactly as if they were installed locally. Restarts on its own.
import type { VmConfig } from "./config";
import { run, withVm } from "./ssh";

/** Public host key of ssh.instabox.sh:2222 (fingerprint SHA256:DQYkbhc9iBYcfVvhXZBsT9qhzAyLvLIyjmm57Vimfxk). */
const GATEWAY_KNOWN_HOSTS = "[ssh.instabox.sh]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEVOufFYj8SrmXvQI092rZncoHoY2a1HnnKS5KavD8xR";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Returns the ports now forwarded and the ones skipped because something on the app machine already uses them. */
export async function linkTunnel(app: VmConfig, db: VmConfig, wanted: number[]): Promise<{ forwarded: number[]; skipped: number[] }> {
  if (app.kind !== "instabox" || db.kind !== "instabox") throw new Error("tunnels work between InstaBox machines");
  if (app.name === db.name) throw new Error("same machine: use localhost directly");
  // stop our own old tunnel first, then see which ports are genuinely taken by something else
  const used = await withVm(app, async (conn) => {
    const r = await run(
      conn,
      `systemctl --user stop hosting-tunnel-${db.name}.service >/dev/null 2>&1; sleep 1; ss -ltnH 2>/dev/null | awk '{print $4}'`,
      { timeoutMs: 20_000 },
    );
    return new Set(r.stdout.split("\n").map((a) => Number(a.split(":").pop())).filter(Number.isFinite));
  });
  const ports = wanted.filter((p) => !used.has(p));
  const skipped = wanted.filter((p) => used.has(p));
  if (!ports.length) return { forwarded: [], skipped };
  const forwards = ports.map((p) => `-L 127.0.0.1:${p}:127.0.0.1:${p}`).join(" ");
  const unit = [
    "[Unit]",
    `Description=hosting: databases on ${db.name} at localhost (${ports.join(", ")})`,
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%h/.hosting/known_hosts -p ${db.port} ${forwards} ${db.username}@${db.host}`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  const unitPath = `"$HOME/.config/systemd/user/hosting-tunnel-${db.name}.service"`;
  const cmd = [
    "umask 077",
    'mkdir -p "$HOME/.hosting" "$HOME/.config/systemd/user"',
    `echo ${b64(GATEWAY_KNOWN_HOSTS + "\n")} | base64 -d > "$HOME/.hosting/known_hosts"`,
    `echo ${b64(unit)} | base64 -d > ${unitPath}`,
    "systemctl --user daemon-reload",
    `systemctl --user enable hosting-tunnel-${db.name}.service >/dev/null 2>&1`,
    `systemctl --user restart hosting-tunnel-${db.name}.service`,
    "sleep 3",
    `systemctl --user is-active hosting-tunnel-${db.name}.service`,
  ].join(" && ");
  return withVm(app, async (conn) => {
    const res = await run(conn, cmd, { timeoutMs: 30_000 });
    const state = res.stdout.trim().split("\n").pop() ?? "";
    if (state !== "active") throw new Error(`tunnel did not start (${state || res.stderr.trim() || "unknown"})`);
    return { forwarded: ports, skipped };
  });
}

export async function unlinkTunnel(app: VmConfig, dbName: string): Promise<void> {
  await withVm(app, async (conn) => {
    await run(
      conn,
      `systemctl --user disable --now hosting-tunnel-${dbName}.service >/dev/null 2>&1; rm -f "$HOME/.config/systemd/user/hosting-tunnel-${dbName}.service"; systemctl --user daemon-reload`,
      { timeoutMs: 20_000 },
    );
  });
}
