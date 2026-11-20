import test from "node:test";
import assert from "node:assert/strict";
import { surfaceLayout } from "../src/shared/surfaceLayout";
import { SurfaceLive, inTree, type Topology } from "../src/ui/surfaceLive";
test("variable-height parent and child subtrees reserve their full bounds", () => {
  const items = [
    { id: "host", height: 234, width: 344 },
    { id: "disk", parent: "host" },
    { id: "train", height: 245, width: 344 },
    { id: "project", parent: "train" },
    ...Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      parent: "project",
      height: 50,
    })),
    { id: "last", height: 152, width: 344 },
  ];
  const positions = surfaceLayout(items),
    dimensions = new Map(items.map((i) => [i.id, i]));
  assert.equal(positions.length, items.length);
  for (const x of new Set(positions.map((n) => n.x))) {
    const col = positions.filter((p) => p.x === x).sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++)
      assert(
        col[i].y >=
          col[i - 1].y + (dimensions.get(col[i - 1].id)?.height ?? 50) + 16,
      );
  }
  assert.equal(positions.find((n) => n.id === "disk")!.x, 396);
});
test("telemetry updates notify an observed tile without changing directory topology", () => {
  const store = new SurfaceLive();
  const initial: Topology = {
    machines: [
      {
        id: "a",
        name: "train",
        endpoint: "a",
        roots: [{ endpoint: "a", path: "/" }],
        kind: "ssh",
        gpus: [{ id: "0" }],
        volumes: [],
      },
    ],
    runs: [{ runId: "r", endpoint: "a", name: "run", updated: 0, step: 1 }],
  };
  assert(store.update(initial));
  let notifications = 0;
  const stop = store.subscribe("run:r", () => notifications++);
  assert.equal(
    store.update({ ...initial, runs: [{ ...initial.runs[0], step: 2 }] }),
    false,
  );
  assert.equal(notifications, 1);
  stop();
  assert(
    store.update({
      ...initial,
      runs: [{ ...initial.runs[0], state: "completed" }],
    }),
  );
  assert.equal(notifications, 1);
  assert(
    store.update({
      ...initial,
      runs: [
        { ...initial.runs[0], projectRef: { endpoint: "a", path: "/exp" } },
      ],
    }),
  );
});
test("subtree scope uses path components and respects endpoint identity", () => {
  const r = (path: string, endpoint = "a") => ({ endpoint, path });
  assert(inTree(r("/"), r("/repo")));
  assert(!inTree(r("/repo"), r("/repo-old")));
  assert(!inTree(r("/repo"), r("/repo", "b")));
  assert(inTree(r("D:\\Repo"), r("d:/repo/src"), true));
});

import { assembleSurface, type SurfaceItem } from "../src/ui/surfaceTree";
import { refKey, type Ref } from "../src/shared/types";
test("project and legacy runs appear once, and a loaded directory replaces its shortcut", () => {
  const root = { endpoint: "train", path: "/" },
    project = { ...root, path: "/experiments" };
  const machine = {
    id: "train",
    name: "Train",
    kind: "ssh",
    endpoint: "train",
    roots: [root],
    gpus: [],
    volumes: [],
  };
  const run = {
    endpoint: "train",
    name: "Voice",
    runId: "a",
    updated: 1,
    projectRef: project,
  };
  const topology = {
    machines: [machine],
    runs: [
      run,
      { ...run, runId: "b", state: "completed" },
      { ...run, runId: "old", projectRef: undefined },
    ],
  };
  function tree(loaded: boolean, scope?: Ref) {
    const virtual: SurfaceItem[] = [],
      files: string[] = [];
    assembleSurface(
      topology,
      scope,
      new Set([refKey(project), "project:" + refKey(project)]),
      (r) => files.push(refKey(r)),
      (r) => (loaded && refKey(r) === refKey(project) ? refKey(r) : undefined),
      (i) => virtual.push(i),
    );
    assert.equal(new Set(virtual.map((n) => n.id)).size, virtual.length);
    return virtual;
  }
  for (const loaded of [true, false]) {
    const rows = tree(loaded),
      owner = loaded ? refKey(project) : "project:" + refKey(project);
    assert.equal(rows.find((r) => r.id === "run:a")?.parent, owner);
    assert.equal(
      rows.find((r) => r.id === "run:b")?.parent,
      "archive:" + owner,
    );
    assert.equal(rows.find((r) => r.id === "run:old")?.parent, "machine:train");
    assert.equal(
      rows.filter((r) => r.kind === "project").length,
      loaded ? 0 : 1,
    );
    assert(rows.every((r) => !("ref" in r)));
  }
  assert.equal(
    tree(false, { ...root, path: "/experiments/src" }).filter(
      (r) => r.kind === "project",
    ).length,
    1,
  );
});
