// How the dashboard groups projects. Shared by the Projects page, the form and the Assistant.
import type { ProjectManifest } from "./types";

export type ProjectType = "website" | "service" | "worker" | "database" | "tool";

export const TYPE_LABEL: Record<ProjectType, { one: string; many: string; hint: string }> = {
  website: { one: "Website", many: "Websites", hint: "Pages people open in a browser" },
  service: { one: "Service", many: "Services", hint: "APIs, models and servers other things call" },
  worker: { one: "Worker", many: "Workers", hint: "Background processes with no port" },
  database: { one: "Database", many: "Databases", hint: "Private, reached through tunnels" },
  tool: { one: "Tool", many: "Tools", hint: "Admin UIs like Adminer" },
};

export const TYPE_ORDER: ProjectType[] = ["website", "service", "worker", "database", "tool"];

const WEB_START = /next start|serve -s|npx --yes serve|http-server|vite preview|nginx|astro|streamlit|manage\.py runserver/;

export function projectType(m: Pick<ProjectManifest, "category" | "kind" | "port" | "start" | "build">): ProjectType {
  if (m.category === "database") return "database";
  if (m.category === "tool") return "tool";
  if (m.kind) return m.kind;
  if (!m.port || !m.start) return "worker";
  if (WEB_START.test(`${m.start} ${m.build}`)) return "website";
  return "service";
}

/** What to store for a chosen type. */
export function typeFields(t: ProjectType): { category: "app" | "database" | "tool"; kind?: "website" | "service" | "worker" } {
  if (t === "database" || t === "tool") return { category: t };
  return { category: "app", kind: t };
}
