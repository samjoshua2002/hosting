// Shared by server and browser: commands that deserve an explicit "are you sure?".
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /\b(shutdown|poweroff|halt|reboot)\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+-R\s+777\s+\/\s*$/,
  />\s*\/dev\/(sd|nvme|vd)/,
  /\bdocker\s+(system|volume)\s+prune\b.*-a/,
  /\bgit\s+push\s+.*--force\b/,
  /\bsystemctl\s+(stop|disable)\s+ssh/,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(command));
}
