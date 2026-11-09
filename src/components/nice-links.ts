"use client";

import { useMemo } from "react";
import { shortLink } from "@/lib/short-link";
import { useClusterMaybe } from "./cluster";

/** Addresses that only work on the machine itself: never worth showing as a link. */
export const LOCAL_URL = /^https?:\/\/(0\.0\.0\.0|127\.0\.0\.1|localhost)(:\d+)?/i;

/**
 * Turns a project's raw machine address (https://8000-xyz.instabox.tech/…) into its short link
 * (<site>/go/<name>), using the projects the dashboard already knows about. Anything else passes through.
 */
export function useNiceLink(): (url: string) => string {
  const c = useClusterMaybe();
  const byHost = useMemo(() => {
    const m = new Map<string, string>();
    const vms = c?.vms ?? [];
    const status = c?.status ?? {};
    for (const v of vms)
      for (const p of status[v.name]?.agent?.projects ?? []) {
        if (!p.url) continue;
        try {
          m.set(new URL(p.url).host, p.manifest.name);
        } catch {}
      }
    return m;
  }, [c?.vms, c?.status]);
  return (url: string) => {
    try {
      const u = new URL(url);
      const name = byHost.get(u.host);
      return name && (u.pathname === "/" || u.pathname === "") ? shortLink(name) : url;
    } catch {
      return url;
    }
  };
}
