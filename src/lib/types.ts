// Shared between server and client. No secrets here.

export type VmKind = "instabox" | "ssh";

/** A VM as the browser sees it: never includes the token or key. */
export interface VmInfo {
  name: string;
  kind: VmKind;
  host: string;
  port: number;
  userHint: string;
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
  envKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectState {
  manifest: ProjectManifest;
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
  /** SSH tunnels from this machine to a database machine */
  tunnels: { to: string; active: string; ports?: number[] }[];
  /** Samples newer than the `since` the caller asked for. */
  history: Sample[];
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
