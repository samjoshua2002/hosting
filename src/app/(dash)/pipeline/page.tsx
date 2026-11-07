"use client";

import { ClusterCanvas } from "@/components/canvas";
import { UnsplashLayer, useTheme } from "@/components/theme";

export default function PipelinePage() {
  const { photo } = useTheme();
  return (
    <div className="h-[calc(100dvh-49px)]">
      {/* the same cover as every page, behind the (transparent) canvas */}
      <UnsplashLayer photo={photo} className="page-cover" />
      <ClusterCanvas />
    </div>
  );
}
