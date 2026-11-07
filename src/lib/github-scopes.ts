// What each classic-token scope lets the dashboard and the Assistant do. Browser-safe.

export interface ScopeInfo {
  scope: string;
  what: string;
  /** what we use it for here, if anything */
  use?: string;
  /** writes with it always need the user's OK */
  sensitive?: boolean;
}

export const SCOPES: ScopeInfo[] = [
  { scope: "repo", what: "Full control of private repositories", use: "Import, read and change code, branches, commits, pull requests, issues, private-repo deploys" },
  { scope: "public_repo", what: "Access public repositories", use: "Same as repo, public repositories only" },
  { scope: "repo:status", what: "Access commit status", use: "Report deploy status on commits" },
  { scope: "repo_deployment", what: "Access deployment status", use: "Record deployments on GitHub" },
  { scope: "repo:invite", what: "Access repository invitations" },
  { scope: "security_events", what: "Read and write security events", use: "Read code-scanning and Dependabot alerts" },
  { scope: "workflow", what: "Update GitHub Action workflows", use: "Edit files under .github/workflows" },
  { scope: "admin:repo_hook", what: "Full control of repository hooks", use: "Push webhooks for auto-deploy" },
  { scope: "write:repo_hook", what: "Write repository hooks", use: "Push webhooks for auto-deploy" },
  { scope: "read:repo_hook", what: "Read repository hooks" },
  { scope: "read:org", what: "Read org and team membership, org projects", use: "List repositories of your organizations" },
  { scope: "write:org", what: "Read and write org and team membership", sensitive: true },
  { scope: "admin:org", what: "Full control of orgs and teams", sensitive: true },
  { scope: "admin:org_hook", what: "Full control of organization hooks", sensitive: true },
  { scope: "manage_runners:org", what: "Manage org runners", sensitive: true },
  { scope: "gist", what: "Create gists", use: "Share logs or snippets as a gist link" },
  { scope: "notifications", what: "Access notifications" },
  { scope: "user", what: "Update all user data", sensitive: true },
  { scope: "read:user", what: "Read all user profile data" },
  { scope: "user:email", what: "Access user email addresses (read-only)" },
  { scope: "user:follow", what: "Follow and unfollow users" },
  { scope: "delete_repo", what: "Delete repositories", sensitive: true },
  { scope: "write:discussion", what: "Read and write team discussions" },
  { scope: "read:discussion", what: "Read team discussions" },
  { scope: "write:packages", what: "Upload packages to GitHub Packages", use: "Push container images to ghcr.io" },
  { scope: "read:packages", what: "Download packages from GitHub Packages", use: "Pull private ghcr.io images" },
  { scope: "delete:packages", what: "Delete packages", sensitive: true },
  { scope: "admin:public_key", what: "Full control of user public keys", sensitive: true },
  { scope: "write:public_key", what: "Write user public keys", sensitive: true },
  { scope: "read:public_key", what: "Read user public keys" },
  { scope: "admin:gpg_key", what: "Full control of GPG keys", sensitive: true },
  { scope: "write:gpg_key", what: "Write GPG keys", sensitive: true },
  { scope: "read:gpg_key", what: "Read GPG keys" },
  { scope: "admin:ssh_signing_key", what: "Full control of SSH signing keys", sensitive: true },
  { scope: "write:ssh_signing_key", what: "Write SSH signing keys", sensitive: true },
  { scope: "read:ssh_signing_key", what: "Read SSH signing keys" },
  { scope: "project", what: "Full control of projects (boards)", use: "Create and update GitHub project boards" },
  { scope: "read:project", what: "Read projects (boards)" },
  { scope: "codespace", what: "Full control of codespaces" },
  { scope: "codespace:secrets", what: "Manage codespace secrets", sensitive: true },
  { scope: "copilot", what: "Full control of Copilot settings", sensitive: true },
  { scope: "manage_billing:copilot", what: "Copilot Business seats", sensitive: true },
  { scope: "write:network_configurations", what: "Write org hosted compute network configurations", sensitive: true },
  { scope: "read:network_configurations", what: "Read org hosted compute network configurations" },
  { scope: "admin:enterprise", what: "Full control of enterprises", sensitive: true },
  { scope: "manage_runners:enterprise", what: "Manage enterprise runners", sensitive: true },
  { scope: "manage_billing:enterprise", what: "Enterprise billing", sensitive: true },
  { scope: "read:enterprise", what: "Read enterprise profile data" },
  { scope: "scim:enterprise", what: "Provision enterprise users (SCIM)", sensitive: true },
  { scope: "audit_log", what: "Full control of audit log", sensitive: true },
  { scope: "read:audit_log", what: "Read audit log" },
];

/** Recommended for this dashboard: code, workflows, webhooks, org repos, gists, profile. */
export const RECOMMENDED = ["repo", "workflow", "admin:repo_hook", "read:org", "gist", "read:user", "user:email"];

export const TOKEN_URL = `https://github.com/settings/tokens/new?description=Hosting%20dashboard&scopes=${RECOMMENDED.join(",")}`;

const PARENT: Record<string, string> = {
  "repo:status": "repo",
  repo_deployment: "repo",
  public_repo: "repo",
  "repo:invite": "repo",
  security_events: "repo",
  "write:repo_hook": "admin:repo_hook",
  "read:repo_hook": "admin:repo_hook",
  "read:org": "admin:org",
  "write:org": "admin:org",
  "read:user": "user",
  "user:email": "user",
  "user:follow": "user",
  "read:discussion": "write:discussion",
  "read:packages": "write:packages",
  "read:public_key": "admin:public_key",
  "write:public_key": "admin:public_key",
  "read:gpg_key": "admin:gpg_key",
  "write:gpg_key": "admin:gpg_key",
  "read:project": "project",
};

/** A scope is granted directly or through its parent (e.g. repo covers repo:status). */
export function hasScope(granted: string[], scope: string): boolean {
  if (granted.includes(scope)) return true;
  let p = PARENT[scope];
  while (p) {
    if (granted.includes(p)) return true;
    p = PARENT[p];
  }
  return false;
}

/** Plain-words summary for the Assistant's instructions. */
export function capabilitySummary(login: string, granted: string[]): string {
  if (!granted.length)
    return `GitHub: connected as @${login} with a fine-grained token (permissions are set per repository on GitHub; if a call returns 403/404, say which permission is missing).`;
  const can = SCOPES.filter((s) => hasScope(granted, s.scope) && s.use).map((s) => `${s.scope} (${s.use})`);
  const cannot = ["repo", "workflow", "admin:repo_hook", "read:org", "gist"].filter((s) => !hasScope(granted, s));
  return [
    `GitHub: connected as @${login}. Token scopes: ${granted.join(", ")}.`,
    can.length ? `You can use: ${can.join("; ")}.` : "",
    cannot.length ? `Not granted (tell the user to make a new token on the Projects page if needed): ${cannot.join(", ")}.` : "",
    "Changing .github/workflows files needs the workflow scope.",
  ]
    .filter(Boolean)
    .join(" ");
}
