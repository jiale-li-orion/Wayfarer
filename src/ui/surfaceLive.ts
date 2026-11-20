import type { MachineMetric } from "./SurfaceCards";
import type { Ref } from "../shared/types";
export type Machine = MachineMetric & {
  id: string;
  kind: string;
  roots: Ref[];
  mount?: string;
};
export type Run = {
  runId: string;
  endpoint: string;
  name: string;
  phase?: string;
  step?: number;
  updated: number;
  lastObserved?: number;
  state?: string;
  observed?: string;
  connection?: string;
  projectRef?: Ref;
};
export function ended(r: Run) {
  if (r.state === "failed") return false;
  return (
    r.state === "completed" ||
    r.state === "exited" ||
    r.observed === "exited" ||
    r.observed === "changed"
  );
}
export function runStatus(r: Run) {
  return r.state === "failed"
    ? "失败"
    : r.connection === "offline"
      ? "离线"
      : r.connection === "unavailable"
        ? "观测暂不可读"
        : r.state === "completed"
          ? "已完成"
          : ended(r)
            ? "进程已退出"
            : (r.phase ??
              (r.state === "running" || r.observed === "alive"
                ? "运行中"
                : "已登记"));
}
export function inTree(root: Ref, ref: Ref, windows = false) {
  if (root.endpoint !== ref.endpoint) return false;
  const clean = (v: string) =>
    windows ? v.replaceAll("\\", "/").toLowerCase() : v;
  const base = clean(root.path).replace(/\/+$/, ""),
    file = clean(ref.path);
  return file === base || file.startsWith(base + "/");
}
export type Topology = { machines: Machine[]; runs: Run[] };
export class SurfaceLive {
  private entries = new Map<string, Machine | Run>();
  private listeners = new Map<string, Set<() => void>>();
  private signature = "";
  get = (key: string) => this.entries.get(key);
  subscribe = (key: string, fn: () => void) => {
    const list = this.listeners.get(key) ?? new Set();
    list.add(fn);
    this.listeners.set(key, list);
    return () => {
      list.delete(fn);
      if (!list.size) this.listeners.delete(key);
    };
  };
  update(snapshot: Topology) {
    const next = new Map<string, Machine | Run>();
    snapshot.machines.forEach((m) => next.set("machine:" + m.endpoint, m));
    snapshot.runs.forEach((r) => next.set("run:" + r.runId, r));
    const previous = this.entries;
    this.entries = next;
    for (const [key, subs] of this.listeners)
      if (next.get(key) !== previous.get(key)) subs.forEach((fn) => fn());
    const signature = JSON.stringify([
      snapshot.machines.map((m) => [
        m.endpoint,
        m.name,
        m.roots,
        m.gpus.length,
      ]),
      snapshot.runs
        .map((r) => [r.runId, r.endpoint, r.projectRef, ended(r)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]);
    if (signature === this.signature) return false;
    this.signature = signature;
    return true;
  }
}
