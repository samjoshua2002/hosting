// Turning what the Assistant made into files you can send: an artifact (report, table, page) becomes a clean,
// printable HTML page, and that page becomes a PDF with headless Chrome on a machine with room (the same browser
// the screenshot tool uses). Files in the chat (uploads, screenshots, PDFs) are sent as they are.
import { marked } from "marked";
import { probe } from "./agent";
import type { Item } from "./assistant-items";
import { loadAttachment } from "./attachments";
import { getVm, getVms } from "./config";
import { sessionPath } from "./sessions";
import { mapLimit, run, withVm } from "./ssh";
import { storeGetJson } from "./store";

type Artifact = Extract<Item, { kind: "artifact" }>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function csvTable(csv: string): string {
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .slice(0, 2000)
    .map((line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? []);
  const [head, ...body] = rows;
  return `<table><thead><tr>${(head ?? []).map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

/** A complete, print-friendly HTML document for an artifact. */
export function artifactHtml(a: Artifact): string {
  if (a.type === "html" && /<html[\s>]/i.test(a.content)) return a.content;
  const body =
    a.type === "markdown" || a.type === "text"
      ? (marked.parse(a.content, { async: false }) as string)
      : a.type === "html"
        ? a.content
        : a.type === "csv"
          ? csvTable(a.content)
          : a.type === "svg"
            ? a.content
            : `<pre>${esc(a.type === "json" ? JSON.stringify(JSON.parse(a.content || "null"), null, 2) : a.content)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(a.title)}</title><style>
  @page { margin: 18mm 16mm; }
  body { font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #18181b; }
  h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -.01em } h2 { font-size: 17px; margin: 22px 0 6px } h3 { font-size: 14px }
  .meta { color: #71717a; font-size: 12px; margin-bottom: 18px }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px }
  th, td { border-bottom: 1px solid #e4e4e7; padding: 6px 8px; text-align: left; vertical-align: top }
  th { background: #f4f4f5; font-weight: 600 }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px }
  pre { background: #f4f4f5; padding: 10px 12px; border-radius: 8px; white-space: pre-wrap }
  a { color: #2563eb }
</style></head><body><h1>${esc(a.title)}</h1><p class="meta">${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</p>${body}</body></html>`;
}

/** Print an HTML document to PDF with headless Chrome on the machine with the most free memory. */
export async function renderPdf(html: string): Promise<Buffer> {
  const fleet = await mapLimit(getVms(), 12, (vm) => probe(vm, 9_999_999_999));
  const pick = fleet.filter((s) => s.ok && s.agent && (s.agent.diskTotalKb - s.agent.diskUsedKb) / 1048576 > 1).sort((x, y) => y.agent!.memAvailKb - x.agent!.memAvailKb)[0];
  const vm = pick ? getVm(pick.name) : undefined;
  if (!vm) throw new Error("no machine with room to render a PDF right now");
  const id = `p${Date.now().toString(36)}`;
  const cmd = [
    'D="$HOME/.hosting/shots"; mkdir -p "$D"; chmod 777 "$D"',
    `cat > "$D/${id}.html"`,
    "docker image inspect zenika/alpine-chrome >/dev/null 2>&1 || docker pull -q zenika/alpine-chrome >/dev/null 2>&1",
    `timeout 100 docker run --rm --shm-size=1g -v "$D":/out zenika/alpine-chrome --no-sandbox --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf=/out/${id}.pdf file:///out/${id}.html >/dev/null 2>&1`,
    `f="$D/${id}.pdf"; rm -f "$D/${id}.html"; if [ -s "$f" ]; then base64 -w0 "$f"; rm -f "$f"; else echo NOPDF; fi`,
  ].join("; ");
  const r = await withVm(vm, (c) => run(c, cmd, { stdin: html, timeoutMs: 240_000, maxBytes: 20 * 1024 * 1024 }));
  const out = r.stdout.trim();
  if (!out || out === "NOPDF") throw new Error(`the browser on ${vm.name} couldn't make the PDF`);
  return Buffer.from(out, "base64");
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

const fileName = (title: string, ext: string) => `${title.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().replace(/\s+/g, " ").slice(0, 80) || "document"}.${ext}`;

/**
 * Files to attach to an email, from this conversation: artifacts by id or title (as PDF by default, else their
 * own format) and chat files by id or name. Unknown names are reported, not silently skipped.
 */
export async function gatherAttachments(sessionId: string | undefined, wanted: { artifact?: string; file?: string; as?: string }[]): Promise<{ files: MailAttachment[]; notes: string[] }> {
  const files: MailAttachment[] = [];
  const notes: string[] = [];
  if (!wanted.length) return { files, notes };
  if (!sessionId) return { files, notes: ["attachments need a conversation"] };
  const doc = await storeGetJson<{ items?: Item[]; attachments?: { id: string; name: string }[] }>(sessionPath(sessionId));
  const items = doc?.items ?? [];
  for (const w of wanted.slice(0, 10)) {
    if (w.artifact) {
      const key = w.artifact.toLowerCase();
      const versions = items.filter((i): i is Artifact => i.kind === "artifact" && (i.id === w.artifact || i.title.toLowerCase() === key || i.title.toLowerCase().includes(key)));
      const a = versions[versions.length - 1];
      if (!a) {
        notes.push(`no artifact called "${w.artifact}" in this conversation`);
        continue;
      }
      const as = (w.as ?? "pdf").toLowerCase();
      if (as === "pdf") {
        try {
          files.push({ filename: fileName(a.title, "pdf"), content: await renderPdf(artifactHtml(a)), contentType: "application/pdf" });
          continue;
        } catch (e) {
          notes.push(`couldn't make a PDF of "${a.title}" (${(e as Error).message}); attached it as an HTML page instead`);
          files.push({ filename: fileName(a.title, "html"), content: Buffer.from(artifactHtml(a)), contentType: "text/html" });
          continue;
        }
      }
      const ext = { markdown: "md", html: "html", code: a.language || "txt", csv: "csv", json: "json", svg: "svg", text: "txt" }[a.type] ?? "txt";
      files.push({ filename: fileName(a.title, ext), content: Buffer.from(a.content), contentType: a.type === "html" ? "text/html" : a.type === "csv" ? "text/csv" : a.type === "json" ? "application/json" : a.type === "svg" ? "image/svg+xml" : "text/plain" });
    } else if (w.file) {
      const key = w.file.toLowerCase();
      const known = [...(doc?.attachments ?? []), ...items.flatMap((i) => (i.kind === "user" ? (i.files ?? []) : []))];
      const meta = known.find((f) => f.id === w.file) ?? known.find((f) => f.name.toLowerCase() === key) ?? known.find((f) => f.name.toLowerCase().includes(key));
      const f = meta ? await loadAttachment(sessionId, meta.id) : null;
      if (!f) {
        notes.push(`no file called "${w.file}" in this conversation`);
        continue;
      }
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      const type = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", csv: "text/csv", txt: "text/plain", zip: "application/zip", json: "application/json", md: "text/markdown", html: "text/html" }[ext] ?? "application/octet-stream";
      files.push({ filename: f.name, content: f.data, contentType: type });
    }
  }
  return { files, notes };
}
