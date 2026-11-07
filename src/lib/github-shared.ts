// Safe for the browser: no tokens, no node APIs.
export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** owner/name from a GitHub URL (https or git@), else null. */
export function repoFromUrl(url: string): string | null {
  const m = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}
