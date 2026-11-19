export type EndpointKind = "windows" | "local" | "wsl" | "ssh";
export interface EndpointConfig {
  id: string;
  name: string;
  kind: EndpointKind;
  root: string;
  host?: string;
  sshConfig?: string;
  distro?: string;
  python?: string;
}
export interface Ref {
  endpoint: string;
  path: string;
}
export interface Entry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "special" | "denied";
  size: number;
  mtime: number;
  ctime: number;
  mode: number;
  identity: string;
  target?: string;
  resolved?: string;
  targetKind?: string;
  linkType?: "symlink" | "junction";
  linkTargetKind?: "file" | "directory";
  error?: string;
  tags?: string[];
}
export interface Page {
  hasMore?: boolean;
  entries: Entry[];
  cursor?: string;
  stamp: number;
  cached?: boolean;
  error?: string;
}
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface Endpoint {
  readonly connected?: boolean;
  config: EndpointConfig;
  call<T = any>(method: string, args?: Record<string, any>): Promise<T>;
  readInto?(
    path: string,
    buffer: Buffer,
    offset: number,
    length: number,
  ): Promise<number>;
  writeBuffer?(path: string, buffer: Buffer, offset: number): Promise<number>;
  openTransfer?(): { endpoint: Endpoint; release(): void };
  dispose(deadline?: number): void | Promise<void>;
  abort?(): void;
}
export type JobState =
  "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export interface Job {
  id: string;
  kind: string;
  operationId?: string;
  operationFingerprint?: string;
  pauseReason?:
    | "shutdown"
    | "process-interrupted"
    | "network"
    | "user"
    | "endpoint-disconnected";
  cleanupPending?: { endpoint: string; path: string; error?: string }[];
  state: JobState;
  created: number;
  updated: number;
  bytes: number;
  files: number;
  progress?: string;
  error?: string;
  result?: any;
  input: any;
  logs: string[];
  checkpoint: Record<string, any>;
}
export interface ViewState {
  modelSelection?: {ref:Ref; attempt?:number; module?:string; sample?:string; follow:boolean};
  root?: Ref;
  expanded: string[];
  viewport: { x: number; y: number; zoom: number };
  bookmarks: Ref[];
  follow: boolean;
  agent?: Ref;
  agentEntry?: Entry;
  history: (Ref | undefined)[];
  historyIndex: number;
}
export const refKey = (r: Ref) => JSON.stringify([r.endpoint, r.path]);
export const parseKey = (k: string): Ref => {
  const [endpoint, path] = JSON.parse(k);
  return { endpoint, path };
};
export const defaultView = (): ViewState => ({
  expanded: [],
  viewport: { x: 60, y: 120, zoom: 1 },
  bookmarks: [],
  follow: false,
  history: [undefined],
  historyIndex: 0,
});
