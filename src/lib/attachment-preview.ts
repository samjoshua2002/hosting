// What the preview panel shows for an attachment: picture/PDF inline, text with a language for highlighting,
// a table for CSV, the file list of a zip, or just its details.
import { unzipSync } from "fflate";
import { asText } from "./attachments";

export type PreviewKind = "image" | "pdf" | "text" | "markdown" | "csv" | "json" | "html" | "zip" | "binary";

export interface Preview {
  name: string;
  size: number;
  kind: PreviewKind;
  /** for text kinds: up to ~300 KB of it */
  text?: string;
  truncated?: boolean;
  language?: string;
  /** for zips: their files */
  entries?: { path: string; size: number }[];
  totalFiles?: number;
}

const LANG: Record<string, string> = {
  js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby", php: "php", go: "go", rs: "rust",
  java: "java", kt: "kotlin", cs: "csharp", c: "c", h: "c", cpp: "cpp", css: "css", scss: "scss", sql: "sql", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml",
  yaml: "yaml", toml: "toml", xml: "xml", ini: "ini", env: "dotenv", dockerfile: "dockerfile", vue: "vue", svelte: "svelte", txt: "text", log: "text", conf: "text",
};
const MAX_TEXT = 300_000;

export function previewOf(name: string, data: Buffer): Preview {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? (/^dockerfile$/i.test(name) ? "dockerfile" : "")).toLowerCase();
  const base = { name, size: data.length };
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) return { ...base, kind: "image" };
  if (ext === "pdf") return { ...base, kind: "pdf" };
  if (ext === "zip") {
    try {
      const entries: { path: string; size: number }[] = [];
      // read only the directory: the filter sees every entry and we decline to extract any
      unzipSync(new Uint8Array(data), {
        filter: (f) => {
          if (!f.name.endsWith("/") && !f.name.startsWith("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(f.name)) entries.push({ path: f.name, size: f.originalSize });
          return false;
        },
      });
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return { ...base, kind: "zip", entries: entries.slice(0, 3000), totalFiles: entries.length };
    } catch {
      return { ...base, kind: "binary" };
    }
  }
  const text = asText(data.subarray(0, MAX_TEXT + 4));
  if (text === null) return { ...base, kind: "binary" };
  const t = { text: text.slice(0, MAX_TEXT), truncated: data.length > MAX_TEXT };
  if (ext === "md" || ext === "markdown") return { ...base, kind: "markdown", ...t };
  if (ext === "csv" || ext === "tsv") return { ...base, kind: "csv", ...t };
  if (ext === "json") return { ...base, kind: "json", ...t };
  if (ext === "html" || ext === "htm") return { ...base, kind: "html", ...t, language: "html" };
  if (/^\.?env(\.|$)/i.test(name)) return { ...base, kind: "text", text: maskEnv(t.text), truncated: t.truncated, language: "dotenv" };
  return { ...base, kind: "text", ...t, language: LANG[ext] ?? "text" };
}

/** .env files never show their values, even to the owner, in a preview. */
function maskEnv(text: string): string {
  return text.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*).+$/gm, "$1••••••••");
}
