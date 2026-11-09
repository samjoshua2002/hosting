// Secrets the user pastes (env blocks, API keys, connection strings) are kept here, encrypted on the storage
// machine, and replaced by {{secret:NAME}} before anything reaches the model or the saved chat. Tools swap the
// real values back in when they run on the machines, and tool output is masked again before the model reads it.
import { seal, unseal, type Sealed } from "./seal";
import { storeGetJson, storePut } from "./store";

const PATH = "vault/secrets.json";
const PURPOSE = "vault:v1";
export const PLACEHOLDER = /\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g;
const HAS_PLACEHOLDER = /\{\{secret:[A-Z][A-Z0-9_]*\}\}/;

let cache: { at: number; map: Record<string, string> } | null = null;

async function load(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.map;
  const s = await storeGetJson<Sealed>(PATH);
  const map = s ? (JSON.parse(unseal(s, PURPOSE)) as Record<string, string>) : {};
  cache = { at: Date.now(), map };
  return map;
}

async function saveAll(map: Record<string, string>) {
  await storePut(PATH, JSON.stringify(seal(JSON.stringify(map), PURPOSE)));
  cache = { at: Date.now(), map };
}

export async function secretNames(): Promise<string[]> {
  return Object.keys(await load()).sort();
}

export async function forgetSecret(name: string): Promise<void> {
  const map = { ...(await load()) };
  delete map[name];
  await saveAll(map);
}

// standalone credentials worth hiding even without a KEY= in front
const TOKENS: [RegExp, string][] = [
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "API_KEY"],
  [/\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g, "GITHUB_TOKEN"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS_ACCESS_KEY_ID"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "SLACK_TOKEN"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "GOOGLE_API_KEY"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT"],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s:@/]+:[^\s@/]+@[^\s'"]+/g, "DATABASE_URL"],
];

/** Hide every secret in pasted text; returns the text with placeholders and remembers the values. */
export async function vaultText(text: string): Promise<string> {
  if (!text) return text;
  const found: Record<string, string> = {};
  let out = text;
  // KEY=value lines (env files): every value is kept, whatever it looks like
  out = out.replace(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(["']?)(.+?)\4\s*$/gm, (line, pre, key, eq, q, value: string) => {
    if (!value || HAS_PLACEHOLDER.test(value) || value.length < 3) return line;
    const name = key.toUpperCase();
    found[name] = value;
    return `${pre}${key}${eq}{{secret:${name}}}`;
  });
  // loose credentials in sentences
  for (const [re, base] of TOKENS) {
    out = out.replace(re, (value) => {
      const existing = Object.entries(found).find(([, v]) => v === value)?.[0];
      if (existing) return `{{secret:${existing}}}`;
      let name = base;
      for (let i = 2; found[name] && found[name] !== value; i++) name = `${base}_${i}`;
      found[name] = value;
      return `{{secret:${name}}}`;
    });
  }
  if (Object.keys(found).length) await saveAll({ ...(await load()), ...found });
  return out;
}

/** Swap placeholders for real values (JSON-safe when the text is a JSON document such as tool arguments). */
export async function revealIn(text: string, json = false): Promise<string> {
  if (!HAS_PLACEHOLDER.test(text)) return text;
  const map = await load();
  return text.replace(PLACEHOLDER, (m, name: string) => {
    const v = map[name];
    if (v === undefined) return m;
    return json ? JSON.stringify(v).slice(1, -1) : v;
  });
}

/** Put placeholders back wherever a real value shows up (tool output going to the model). */
export async function maskSecrets(text: string): Promise<string> {
  const map = await load();
  let out = text;
  for (const [name, v] of Object.entries(map).sort((a, b) => b[1].length - a[1].length)) if (v.length >= 6) out = out.split(v).join(`{{secret:${name}}}`);
  return out;
}

/** What the chat shows: KEY=••• instead of the placeholder text. */
export function displayMasked(text: string): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => `••••(${name}, saved)`);
}

/** Store one named secret (used by connectors: the token stays sealed, the model only ever sees the name). */
export async function setSecret(name: string, value: string): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new Error("bad secret name");
  await saveAll({ ...(await load()), [name]: value });
}

/** Read one named secret on the server (never sent to the browser or the model). */
export async function getSecret(name: string): Promise<string | undefined> {
  return (await load())[name];
}
