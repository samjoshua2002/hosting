// Shared between server and client. No secrets here.

export type VmKind = "instabox" | "ssh";

/** A VM as the browser sees it: never includes the token or key. */
export interface VmInfo {
  name: string;
  kind: VmKind;
  host: string;
  port: number;
  userHint: string;
  /** added from the dashboard, so it can be removed there */
  added?: boolean;
}

export interface ProjectManifest {
  name: string;
  repo: string;
  branch: string;
  install: string;
  build: string;
  start: string;
  port: number | null;
  publish: boolean;
  /** public: anyone with the URL; private: the URL carries a secret token */
  access?: "public" | "private";
  /** what the dashboard groups it under; databases get their own page */
  category?: "app" | "database" | "tool";
  /** for apps: website (pages people visit), service (API), worker (no port) */
  kind?: "website" | "service" | "worker";
  /** detected or chosen framework, for display: "Next.js", "FastAPI"… */
  framework?: string;
  /** set when imported from GitHub; autoDeploy redeploys on every push to the branch */
  github?: GithubLink | null;
  /** other projects this one talks to, and the env var that points at each */
  uses?: { name: string; env: string; keys?: string[] }[];
  /** made from a Services catalog entry (its id) */
  template?: string;
  /** third-party software the Assistant installed that isn't in the catalog: shown on the Services page like one */
  service?: CustomServiceInfo;
  envKeys: string[];
  createdAt: string;
  updatedAt: string;
}

/** What the Services page and the Assistant know about a service that isn't in the catalog. */
export interface CustomServiceInfo {
  /** product name, e.g. "Plausible Analytics" */
  title: string;
  /** one of the catalog categories (Storage, Monitoring, Analytics, Automation, AI, Developer tools, Databases, Database tools) or "Other" */
  category: string;
  desc: string;
  /** how to sign in: a literal user or the env key that holds it, and the env key holding the password */
  login?: { user?: string; userEnv?: string; passEnv?: string; note?: string };
  /** how to use it, step by step ({name}, {vm}, {port} are filled in) */
  usage?: string[];
  /** the product's documentation */
  docs?: string;
  /** what the Assistant learned while working with it (API calls that work, gotchas), newest last */
  notes?: string[];
}

export interface GithubLink {
  /** owner/name */
  repo: string;
  private: boolean;
  autoDeploy: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  /** unix seconds */
  time: number | null;
}

export interface ProjectState {
  manifest: ProjectManifest;
  /** the commit that is deployed (git projects) */
  commit?: CommitInfo | null;
  /** systemd state: active | inactive | failed | activating | unknown */
  active: string;
  deployedAt: number | null;
  /** the published HTTPS link (private links include their token) */
  url?: string | null;
}

export interface JobMeta {
  label: string;
  kind: "command" | "deploy";
  project?: string;
  command?: string;
  startedAt: number;
}

export interface JobState {
  id: string;
  meta: JobMeta;
  state: "running" | "done" | "lost";
  exitCode: number | null;
  endedAt: number | null;
}

export interface PublishedPort {
  port: number;
  name: string;
  url: string;
  access: string;
}

export interface AgentStatus {
  v: string;
  hostname: string;
  os: string;
  cores: number;
  memTotalKb: number;
  memAvailKb: number;
  load: [number, number, number];
  cpuPct: number;
  uptimeSec: number;
  diskTotalKb: number;
  diskUsedKb: number;
  netRx: number;
  netTx: number;
  docker: boolean;
  projects: ProjectState[];
  jobs: JobState[];
  ports: PublishedPort[];
  /** crontab entries; name is empty for entries added by hand */
  cron: CronEntry[];
  /** SSH tunnels from this machine to a database machine */
  tunnels: { to: string; active: string; ports?: number[] }[];
  /** Samples newer than the `since` the caller asked for. */
  history: Sample[];
}

export interface CronEntry {
  name: string;
  schedule: string;
  command: string;
}

/** [unix seconds, cpu %, memUsedKb, diskUsedKb, load1, netRxBytes, netTxBytes] */
export type Sample = [number, number, number, number, number, number, number];

export interface VmStatus {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
  checkedAt: number;
  agent?: AgentStatus;
}

export interface ExecResult {
  vm: string;
  command?: string;
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  error?: string;
  truncated?: boolean;
}

export interface JobStartResult {
  vm: string;
  id?: string;
  error?: string;
}

export interface JobLog {
  state: JobState["state"];
  exitCode: number | null;
  log: string;
}

export interface BannerPhoto {
  id: string;
  raw: string;
  color: string | null;
  alt: string;
  author: string;
  authorUrl: string;
  link: string;
}
