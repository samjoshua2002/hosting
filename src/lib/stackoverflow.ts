// Stack Overflow search for the Assistant: when an error isn't obvious, look up how others fixed it.
// Uses the public Stack Exchange API (no key needed, ~300 requests a day per IP; STACKEXCHANGE_KEY raises it).
// Returns the best matching questions with their accepted or top-voted answers as plain text.
import { scrub } from "./telemetry";

const API = "https://api.stackexchange.com/2.3";

interface Question {
  question_id: number;
  title: string;
  link: string;
  score: number;
  is_answered: boolean;
  accepted_answer_id?: number;
  tags: string[];
  creation_date: number;
}
interface Answer {
  answer_id: number;
  question_id: number;
  score: number;
  is_accepted: boolean;
  body: string;
}

/** HTML from the API to readable text: code blocks kept, tags dropped, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_, c: string) => `\n\`\`\`\n${c}\n\`\`\`\n`)
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|li|h\d)>/g, "\n")
    .replace(/<li>/g, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ site: "stackoverflow", ...params, ...(process.env.STACKEXCHANGE_KEY ? { key: process.env.STACKEXCHANGE_KEY } : {}) });
  const r = await fetch(`${API}${path}?${q}`, { headers: { "User-Agent": "hosting-dashboard" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Stack Overflow search failed (${r.status}): ${(await r.text()).slice(0, 160)}`);
  const d = (await r.json()) as { items?: T[]; error_message?: string };
  if (d.error_message) throw new Error(`Stack Overflow: ${d.error_message}`);
  return (d.items ?? []) as T;
}

/**
 * Search Stack Overflow. The query is scrubbed of secrets first (error text can carry tokens or URLs with passwords).
 * tags narrows it (e.g. "next.js;docker"). Returns up to `limit` questions, each with its best answer.
 */
export async function searchStackOverflow(query: string, opts: { tags?: string; limit?: number } = {}): Promise<string> {
  const q = scrub(query, 240)
    .replace(/[0-9a-f]{12,}/gi, "") // long ids and hashes only hurt the match
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return "Give a search query (the key part of the error, plus the tool or framework).";
  const limit = Math.min(Math.max(opts.limit ?? 4, 1), 6);
  const questions = (await get<Question[]>("/search/advanced", { order: "desc", sort: "relevance", q, answers: "1", pagesize: String(limit * 2), ...(opts.tags ? { tagged: opts.tags } : {}) }))
    .filter((x) => x.is_answered)
    .slice(0, limit);
  if (!questions.length) return `No answered Stack Overflow questions for "${q}". Try fewer, more specific words (the exact error message without paths or ids).`;
  const answers = await get<Answer[]>(`/questions/${questions.map((x) => x.question_id).join(";")}/answers`, { order: "desc", sort: "votes", filter: "withbody", pagesize: "30" });
  const best = new Map<number, Answer>();
  for (const a of answers) {
    const cur = best.get(a.question_id);
    if (!cur || (a.is_accepted && !cur.is_accepted) || (a.is_accepted === cur.is_accepted && a.score > cur.score)) best.set(a.question_id, a);
  }
  const out = questions.map((x, i) => {
    const a = best.get(x.question_id);
    const year = new Date(x.creation_date * 1000).getFullYear();
    const body = a ? text(a.body).slice(0, 1800) : "(no answer text)";
    return `${i + 1}. ${text(x.title)} (score ${x.score}, ${year}, tags: ${x.tags.slice(0, 5).join(", ")})\n${x.link}\n${a ? `${a.is_accepted ? "Accepted" : "Top"} answer (score ${a.score}):` : ""}\n${body}`;
  });
  return `Stack Overflow results for "${q}" (community answers; check they fit this version and setup before applying, and prefer recent ones):\n\n${out.join("\n\n---\n\n")}`;
}
