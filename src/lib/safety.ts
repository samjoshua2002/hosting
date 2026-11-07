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
  /\bapt(-get)?\s+(-\S+\s+)*(remove|purge|autoremove)\b/,
  /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
  /\bdropdb\b|\bdb\.dropDatabase\(|\bFLUSHALL\b/i,
  /\b(userdel|wipefs|shred)\b/,
  /\bdocker\s+volume\s+rm\b/,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(command));
}
