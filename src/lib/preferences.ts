// How the Assistant works, set in Settings → Code (like Claude Code's settings). Kept with the dashboard's data
// and turned into instructions for every run.
import { storeGetJson, storePut } from "./store";

export interface Preferences {
  /** start of every branch name the Assistant creates */
  branchPrefix: string;
  /** look at every page it deploys or changes with a real screenshot before saying it's done */
  verifyScreenshots: boolean;
  /** end with a short summary and 1-3 next steps */
  summaryNextSteps: boolean;
  /** how replies read */
  replyStyle: "default" | "concise" | "detailed";
}

export const DEFAULT_PREFERENCES: Preferences = { branchPrefix: "assistant", verifyScreenshots: true, summaryNextSteps: true, replyStyle: "default" };
const PATH = "assistant/preferences.json";

export async function getPreferences(): Promise<Preferences> {
  return { ...DEFAULT_PREFERENCES, ...((await storeGetJson<Partial<Preferences>>(PATH).catch(() => null)) ?? {}) };
}

export async function setPreferences(p: Partial<Preferences>): Promise<Preferences> {
  const cur = await getPreferences();
  const next: Preferences = {
    branchPrefix: typeof p.branchPrefix === "string" ? p.branchPrefix.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "assistant" : cur.branchPrefix,
    verifyScreenshots: typeof p.verifyScreenshots === "boolean" ? p.verifyScreenshots : cur.verifyScreenshots,
    summaryNextSteps: typeof p.summaryNextSteps === "boolean" ? p.summaryNextSteps : cur.summaryNextSteps,
    replyStyle: p.replyStyle === "concise" || p.replyStyle === "detailed" || p.replyStyle === "default" ? p.replyStyle : cur.replyStyle,
  };
  await storePut(PATH, JSON.stringify(next));
  return next;
}

/** The preferences as instructions for the model. */
export function preferenceRules(p: Preferences): string {
  return [
    "The user's Assistant settings:",
    `- Branches you create start with "${p.branchPrefix}/" (e.g. ${p.branchPrefix}/fix-login).`,
    p.verifyScreenshots ? "- Always verify web pages you deploy or change with the screenshot tool before saying they're done." : "- Screenshots are optional: verify with HTTP checks, and take screenshots only when the user asks or a page looks wrong.",
    p.summaryNextSteps ? "- End finished tasks with a short summary and 1-3 suggested next steps (as >> lines)." : "- Don't add suggested next steps at the end; keep the ending to the result.",
    p.replyStyle === "concise" ? "- Reply style: concise. Short sentences, bullets, only what matters." : p.replyStyle === "detailed" ? "- Reply style: detailed. Explain what you did and why, with the evidence." : "",
  ]
    .filter(Boolean)
    .join("\n");
}
