import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core/core";
import { Jobs } from "../src/core/jobs";
import { Profiler } from "../src/core/log";
const quiet = new Profiler(() => {});
test("legacy task migration pages disk history while recoverable tasks remain resident", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-history-"));
  const make = (i: number, state = "completed") => ({
    id: "legacy-" + i,
    kind: "size",
    created: 1700000000000 + i,
    updated: 1700000000000 + i,
    state,
    bytes: i,
    files: 1,
    input: { ref: { endpoint: "a", path: "/tmp" } },
    result: { bytes: i },
    logs: ["legacy output"],
    checkpoint: {},
  });
  try {
    for (let i = 0; i < 1003; i++)
      await fs.writeFile(
        path.join(dir, `legacy-${i}.json`),
        JSON.stringify(make(i, i === 1002 ? "paused" : "completed")),
      );
    const jobs = new Jobs(dir, quiet);
    await jobs.init();
    assert.equal(jobs.records.size, 1);
    assert.equal(jobs.get("legacy-1002").state, "paused");
    const first = await jobs.page(undefined, 30);
    assert.equal(first.active.length, 1);
    assert.equal(first.total, 1002);
    assert.equal(first.history.length, 30);
    const second = await jobs.page(first.cursor, 30);
    assert.equal(
      new Set([...first.history, ...second.history].map((j) => j.id)).size,
      60,
    );
    assert.equal((await jobs.details("legacy-1")).result.bytes, 1);
    assert.equal((await jobs.details("legacy-1")).logs[0], "legacy output");
    assert.equal(jobs.stats().records, 1);
    await jobs.dispose();
    const restored = new Jobs(dir, quiet);
    await restored.init();
    assert.equal(restored.stats().historyOnDisk, 1002);
    assert.equal(restored.records.size, 1);
    await restored.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("inspection is shallow, timestamped, coalesced and explicitly refreshed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-inspect-"));
  const state = path.join(dir, "state");
  const core = new Core(state, path.resolve("helpers/endpoint.py"), quiet);
  try {
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(path.join(dir, "nested", "Cargo.toml"), "[package]");
    await fs.writeFile(path.join(dir, "package.json"), "{secret:do not read}");
    await fs.mkdir(path.join(dir, ".venv"));
    await fs.symlink("nested", path.join(dir, "link"));
    await core.init([{ id: "a", kind: "local", name: "fixture", root: dir }]);
    const ref = { endpoint: "a", path: dir };
    const endpoint = core.endpoints.get("a"),
      original = endpoint.call.bind(endpoint);
    let stats = 0,
      reads = 0;
    endpoint.call = async (method, args) => {
      if (method === "stat") stats++;
      if (method === "read") reads++;
      return original(method, args);
    };
    const [one, two] = await Promise.all([
      core.dispatch("inspect", { ref }),
      core.dispatch("inspect", { ref }),
    ]);
    assert.equal(one.stamp, two.stamp);
    assert(one.value.tags.includes("Node"));
    assert(!one.value.tags.includes("Rust"));
    assert.equal(reads, 0);
    const n = stats;
    await core.dispatch("inspect", { ref });
    assert.equal(stats, n);
    await core.dispatch("inspect", { ref, refresh: true });
    assert(stats > n);
    const link = await core.dispatch("inspect", {
      ref: { ...ref, path: path.join(dir, "link") },
    });
    assert.equal(link.value.entry.kind, "symlink");
    assert.equal(link.value.markers.length, 0);
    await core.dispatch("registerProject", { ref });
    assert.equal((await core.dispatch("projects")).length, 1);
    const before = await core.dispatch("diagnostics");
    assert.equal(before.inspector.pending, 0);
    assert(before.inspector.snapshots <= 64);
    for (let i = 0; i < 70; i++) {
      const item = path.join(dir, "f" + i);
      await fs.writeFile(item, "x");
      await core.dispatch("inspect", { ref: { ...ref, path: item } });
    }
    assert.equal((await core.dispatch("diagnostics")).inspector.snapshots, 64);
    await core.dispose();
    const next = new Core(state, path.resolve("helpers/endpoint.py"), quiet);
    await next.init([{ id: "a", kind: "local", name: "fixture", root: dir }]);
    assert.equal((await next.dispatch("projects")).length, 1);
    await next.dispose();
  } finally {
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("inventory merges simultaneous requests and cancellation releases its child", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-inventory-"));
  const core = new Core(
    path.join(dir, "state"),
    path.resolve("helpers/endpoint.py"),
    quiet,
  );
  try {
    await core.init([{ id: "a", kind: "local", name: "fixture", root: dir }]);
    const endpoint = core.endpoints.get("a"),
      original = endpoint.call.bind(endpoint);
    endpoint.call = (async (method: string, args: any) =>
      method === "which"
        ? args?.name === "python3"
          ? process.execPath
          : null
        : method === "execStart"
          ? original(method, {
              ...args,
              argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
            })
          : original(method, args)) as typeof endpoint.call;
    const [a, b] = await Promise.all([
      core.dispatch("inventory", { endpoint: "a", cwd: dir }),
      core.dispatch("inventory", { endpoint: "a", cwd: dir }),
    ]);
    assert.equal(a.id, b.id);
    while (!(await original("resources")).processes) {
      if (core.jobs.get(a.id).state === "failed")
        throw Error(core.jobs.get(a.id).error);
      await new Promise((r) => setTimeout(r, 10));
    }
    core.jobs.control(a.id, "cancel");
    for (
      let i = 0;
      i < 200 && ["running", "queued"].includes(core.jobs.get(a.id).state);
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(core.jobs.get(a.id).state, "cancelled");
    assert.equal((await original("resources")).processes, 0);
  } finally {
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
