import { Suspense } from "react";
import { ProjectView } from "./project-view";

// The project name is URL data, so the view renders inside Suspense (Next 16 prerenders the shell).
export default function ProjectPage() {
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-7xl px-10 py-8 text-sm text-muted">Loading…</div>}>
      <ProjectView />
    </Suspense>
  );
}
