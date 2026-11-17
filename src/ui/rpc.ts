declare const acquireVsCodeApi: () => {
  postMessage: (m: any) => void;
  setState: (state: unknown) => void;
};
const vscode = acquireVsCodeApi();
vscode.setState({ version: 1 });
const pageId = crypto.randomUUID();
let seq = 0;
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
const listeners = new Set<(v: any) => void>();
export function rpc<T = any>(method: string, args: any = {}): Promise<T> {
  if (
    [
      "write",
      "transfer",
      "mkdir",
      "mkdirPath",
      "rename",
      "renamePath",
      "delete",
      "package",
      "inventory",
      "size",
      "search",
    ].includes(method) &&
    !args.operationId
  )
    args = { ...args, operationId: crypto.randomUUID() };
  const id = pageId + ":" + ++seq;
  vscode.postMessage({ id, method, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(Error(m.error));
    else p?.resolve(m.result);
  } else for (const l of listeners) l(m);
});

export function subscribe(listener: (event: any) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let jobReaders = 0;
export function subscribeJobs(listener: (event: any) => void) {
  if (jobReaders++ === 0) void rpc("jobSubscription", { enabled: true });
  const stop = subscribe((event) => {
    if (event.type === "job") listener(event);
  });
  return () => {
    stop();
    if (--jobReaders === 0) void rpc("jobSubscription", { enabled: false });
  };
}

window.addEventListener(
  "pagehide",
  () => {
    for (const p of pending.values()) p.reject(Error("Map panel closed"));
    pending.clear();
    listeners.clear();
    jobReaders = 0;
  },
  { once: true },
);
