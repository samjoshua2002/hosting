// The Assistant conversation as the UI shows it. Shared by the browser and the server, which keeps
// its own copy up to date while a run goes on so the session survives closed tabs and page changes.

export interface Att {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface Shell {
  command: string;
  vms: string[];
  /** shown instead of user@machine:~$ (e.g. "postgres=#") */
  prompt?: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  kind?: string;
  sub?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export type Item =
  | { kind: "user"; text: string; files?: Att[] }
  | { kind: "text"; text: string }
  | { kind: "step"; id: string; label: string; running: boolean; ok?: boolean; output?: string; shell?: Shell }
  | { kind: "approval"; id: string; label: string; detail: string; diff?: boolean; decision?: boolean }
  | { kind: "question"; id: string; question: string; options: string[]; answer?: string }
  | { kind: "diagram"; id: string; title: string; nodes: DiagramNode[]; edges: DiagramEdge[] }
  | { kind: "artifact"; id: string; title: string; type: ArtifactType; language?: string; content: string; version: number }
  | { kind: "plan"; id: string; title: string; steps: PlanStep[] };

/** One line of the Assistant's live plan (a checklist that updates in place while it works). */
export interface PlanStep {
  text: string;
  status: "todo" | "doing" | "done" | "failed" | "skipped";
  note?: string;
}

/** Documents the Assistant makes (reports, scripts, pages, data), shown in a side panel like Claude's. */
export type ArtifactType = "markdown" | "html" | "code" | "csv" | "json" | "svg" | "text";

/** Events the operator streams. */
export type OperatorEvent =
  | { type: "text"; content: string }
  | { type: "tool"; id: string; label: string; shell?: Shell }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "approval"; id: string; label: string; detail: string; diff?: boolean }
  | { type: "question"; id: string; question: string; options: string[] }
  | { type: "diagram"; id: string; title: string; nodes: DiagramNode[]; edges: DiagramEdge[] }
  | { type: "artifact"; id: string; title: string; artType: ArtifactType; language?: string; content: string }
  | { type: "plan"; id: string; title: string; steps: PlanStep[] }
  // transcript is the model-side history (ChatMessage[]), opaque to the UI
  | { type: "done"; transcript: unknown[]; waiting: boolean; paused: boolean };

export function applyEvent(items: Item[], e: OperatorEvent): Item[] {
  switch (e.type) {
    case "text":
      return [...items, { kind: "text", text: e.content }];
    case "tool":
      return [...items, { kind: "step", id: e.id, label: e.label, running: true, shell: e.shell }];
    case "tool_result":
      return items.map((i) => (i.kind === "step" && i.id === e.id ? { ...i, running: false, ok: e.ok, output: e.output } : i));
    case "approval":
      return [...items, { kind: "approval", id: e.id, label: e.label, detail: e.detail, diff: e.diff }];
    case "question":
      return [...items, { kind: "question", id: e.id, question: e.question, options: e.options }];
    case "diagram":
      return [...items, { kind: "diagram", id: e.id, title: e.title, nodes: e.nodes, edges: e.edges }];
    case "plan": {
      // the same plan again updates the card in place, so progress reads like a checklist
      const at = items.findIndex((i) => i.kind === "plan" && i.id === e.id);
      const plan: Item = { kind: "plan", id: e.id, title: e.title, steps: e.steps };
      return at >= 0 ? items.map((i, n) => (n === at ? plan : i)) : [...items, plan];
    }
    case "artifact": {
      // same id again = a new version of that artifact
      const prev = items.filter((i): i is Extract<Item, { kind: "artifact" }> => i.kind === "artifact" && i.id === e.id);
      const version = prev.length ? Math.max(...prev.map((p) => p.version)) + 1 : 1;
      return [...items, { kind: "artifact", id: e.id, title: e.title, type: e.artType, language: e.language, content: e.content, version }];
    }
    default:
      return items;
  }
}

/** A step that never got its result (stopped, timed out) is no longer running. */
export function settle(items: Item[]): Item[] {
  return items.map((i) => (i.kind === "step" && i.running ? { ...i, running: false } : i));
}

/** The newest version of each artifact in a conversation. */
export function latestArtifacts(items: Item[]): Extract<Item, { kind: "artifact" }>[] {
  const map = new Map<string, Extract<Item, { kind: "artifact" }>>();
  for (const i of items) if (i.kind === "artifact") map.set(i.id, i);
  return [...map.values()];
}
