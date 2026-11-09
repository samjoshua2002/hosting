import { Boxes, FolderGit2, LayoutDashboard, MessagesSquare, Server, Settings, ShieldCheck, SquareTerminal, Workflow, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Sidebar sections, in order. */
export const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: "Main menu",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/projects", label: "Projects", icon: FolderGit2 },
      { href: "/services", label: "Services", icon: Boxes },
      { href: "/pipeline", label: "Pipeline", icon: Workflow },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: "/assistant", label: "Assistant", icon: MessagesSquare },
      { href: "/run", label: "Run", icon: SquareTerminal },
    ],
  },
  {
    title: "General",
    items: [
      { href: "/machines", label: "Machines", icon: Server },
      { href: "/security", label: "Security", icon: ShieldCheck },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

/** Breadcrumb label for a path. */
export function crumbs(path: string | null): string[] {
  if (!path || path === "/") return ["Overview"];
  const [first, ...rest] = path.split("/").filter(Boolean);
  const page = NAV.flatMap((g) => g.items).find((i) => i.href === `/${first}`)?.label ?? first;
  return [page, ...rest.map(decodeURIComponent)];
}
