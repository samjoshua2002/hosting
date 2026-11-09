// Standing instructions the user writes for the Assistant (like Claude's project instructions): kept with the
// dashboard's data and added to every conversation's instructions.
import { storeGet, storePut } from "./store";

const PATH = "assistant/instructions.md";
export const MAX_INSTRUCTIONS = 8000;

export async function getInstructions(): Promise<string> {
  return ((await storeGet(PATH).catch(() => null))?.toString("utf8") ?? "").slice(0, MAX_INSTRUCTIONS);
}

export async function setInstructions(text: string): Promise<string> {
  const t = text.replace(/\r\n/g, "\n").trim().slice(0, MAX_INSTRUCTIONS);
  await storePut(PATH, t);
  return t;
}
