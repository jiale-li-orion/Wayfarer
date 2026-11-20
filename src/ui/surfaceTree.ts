import { refKey, type Ref } from "../shared/types";
import { ended, inTree, type Topology, type Run } from "./surfaceLive";

type SpecialKind = "machine" | "project" | "archive" | "run";
export type SurfaceItem = {
  id: string;
  kind: SpecialKind;
  label: string;
  parent?: string;
  owner?: string;
  projectLocation?: Ref;
};
// Only directory() may introduce a filesystem node. Shortcuts and experiments
// have map identities independently of the paths they can navigate to.
export function assembleSurface(
  topology: Topology,
  root: Ref | undefined,
  archives: Set<string>,
  directory: (r: Ref, parent: string) => void,
  existing: (r: Ref) => string | undefined,
  emit: (node: SurfaceItem) => void,
) {
  const hosts = new Map<string, string>(),
    projects = new Map<string, string>();
  const windows = new Set(
    topology.machines
      .filter((m) => m.kind === "windows")
      .flatMap((m) => m.roots.map((r) => r.endpoint)),
  );
  const projectKey = (r: Ref) =>
    refKey(
      windows.has(r.endpoint)
        ? { ...r, path: r.path.replaceAll("/", "\\").toLowerCase() }
        : r,
    );
  const shortcut = (ref: Ref, parent: string) => {
    const key = projectKey(ref),
      prior = projects.get(key);
    if (prior) return prior;
    const id = "project:" + key;
    emit({
      id,
      kind: "project",
      parent,
      label: ref.path.split(/[\\/]/).filter(Boolean).at(-1) ?? ref.path,
      projectLocation: ref,
    });
    projects.set(key, id);
    return id;
  };
  for (const host of topology.machines) {
    if (root && !host.roots.some((r) => r.endpoint === root.endpoint)) continue;
    const id = "machine:" + host.endpoint;
    emit({ id, kind: "machine", label: host.name });
    for (const ref of host.roots) hosts.set(ref.endpoint, id);
    if (!root) {
      for (const ref of host.roots) directory(ref, id);
      continue;
    }
    const ancestors = new Map<string, Ref>();
    for (const run of topology.runs) {
      const p = run.projectRef;
      if (
        p &&
        inTree(p, root, windows.has(p.endpoint)) &&
        projectKey(p) !== projectKey(root)
      )
        ancestors.set(projectKey(p), p);
    }
    let parent = id;
    for (const p of [...ancestors.values()].sort(
      (a, b) => a.path.length - b.path.length,
    ))
      parent = shortcut(p, parent);
    directory(root, parent);
  }
  const finished = new Map<string, Run[]>();
  for (const run of topology.runs) {
    let owner = hosts.get(run.endpoint);
    if (!owner) continue;
    const p = run.projectRef;
    if (p) {
      if (
        root &&
        !inTree(root, p, windows.has(p.endpoint)) &&
        !inTree(p, root, windows.has(p.endpoint))
      )
        continue;
      owner = existing(p) ?? shortcut(p, owner);
    }
    if (ended(run)) {
      const rows = finished.get(owner) ?? [];
      rows.push(run);
      finished.set(owner, rows);
    } else
      emit({
        id: "run:" + run.runId,
        kind: "run",
        label: run.name,
        parent: owner,
      });
  }
  for (const [owner, rows] of finished) {
    const id = "archive:" + owner,
      open = archives.has(owner);
    emit({
      id,
      kind: "archive",
      label: (open ? "▾ " : "▸ ") + "最近结束 · " + rows.length,
      parent: owner,
      owner,
    });
    if (open)
      for (const run of rows)
        emit({
          id: "run:" + run.runId,
          kind: "run",
          label: run.name,
          parent: id,
        });
  }
}
