import type { ReactNode } from "react";
import { ClusterProvider } from "@/components/cluster";
import { Shell } from "@/components/shell";

export default function DashLayout({ children }: { children: ReactNode }) {
  return (
    <ClusterProvider>
      <Shell>{children}</Shell>
    </ClusterProvider>
  );
}
