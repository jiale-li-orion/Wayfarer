import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
const python =
  process.env.WM_TEST_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");
const pause = () => new Promise((r) => setTimeout(r, 10));
async function fixture(pageSize = 200) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-storage-"));
  const root = path.join(dir, "中文 source");
  await fs.mkdir(root);
  const lines: string[] = [];
  const core = new Core(
    path.join(dir, "state"),
    path.resolve("helpers/endpoint.py"),
    new Profiler((s) => lines.push(s)),
    { pageSize, monitorPython: python },
  );
  await core.init([
    {
      id: "fixture",
      name: "Fixture",
      kind: process.platform === "win32" ? "windows" : "local",
      root: dir,
    },
  ]);
  const ref = { endpoint: "fixture", path: root };
  return {
    dir,
    root,
    core,
    ref,
    lines,
    async done() {
      await core.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
async function finish(core: Core, id: string) {
  const until = Date.now() + 30000;
  while (["queued", "running"].includes(core.jobs.get(id).state)) {
    if (Date.now() > until) throw Error("storage task did not finish");
    await pause();
  }
  return core.jobs.get(id);
}
test("storage preserves hardlink sharing and sparse allocation, skips links, and serves retained child pages", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, "a"));
    await fs.mkdir(path.join(f.root, "b"));
    const file = path.join(f.root, "a", "data.bin");
    await fs.writeFile(file, Buffer.alloc(8192, 1));
    await fs.link(file, path.join(f.root, "b", "shared.bin"));
    await fs.link(file, path.join(f.dir, "outside.bin"));
    if (process.platform !== "win32")
      await fs.symlink(f.root, path.join(f.root, "cycle"));
    const sparse = await fs.open(path.join(f.root, "sparse.bin"), "w");
    await sparse.truncate(8 * 2 ** 20);
    await sparse.close();
    const j = await f.core.dispatch("storageScan", {
      ref: f.ref,
      operationId: "storage-fixture",
    });
    const same = await f.core.dispatch("storageScan", {
      ref: f.ref,
      operationId: "storage-fixture",
    });
    assert.equal(j.id, same.id);
    assert.equal((await finish(f.core, j.id)).state, "completed");
    const first = await f.core.dispatch("storageResult", {
      id: j.id,
      limit: 1,
    });
    assert.equal(first.rows.length, 1);
    assert(first.hasMore);
    const second = await f.core.dispatch("storageResult", {
      id: j.id,
      limit: 1,
      offset: 1,
    });
    assert.notEqual(first.rows[0].id, second.rows[0].id);
    const s = first.directory;
    assert.equal(s.logicalBytes, 2 * 8192 + 8 * 2 ** 20);
    assert.equal(s.files, 3);
    if (process.platform !== "win32") {
      assert(s.allocatedBytesKnown < s.logicalBytes);
      assert.equal(s.externallySharedBytesKnown, 8192);
      assert.equal(s.reclaimableUpperBoundBytes, s.allocatedBytesKnown - 8192);
      assert.equal(first.snapshot.skippedLinks, 1);
    }
    const before = f.lines.filter(
      (x) => JSON.parse(x).stage === "storage.scan",
    ).length;
    const child = await f.core.dispatch("storageResult", {
      id: j.id,
      directory: first.rows[0].id,
    });
    assert.equal(child.directory.id, first.rows[0].id);
    assert.equal(
      f.lines.filter((x) => JSON.parse(x).stage === "storage.scan").length,
      before,
    );
    assert.equal(f.core.storageAnalysis.stats().channels, 0);
    const concise = await f.core.dispatch("job", {
      id: j.id,
      fields: ["summary"],
    });
    assert(!("logs" in concise));
    assert(!("input" in concise));
    assert(!("result" in concise));
  } finally {
    await f.done();
  }
});
test("same-volume scans serialize, cancellation retains partial results and releases resources", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 700; i++) {
      const d = path.join(f.root, String(i));
      await fs.mkdir(d);
      await fs.writeFile(path.join(d, "file"), "x");
    }
    const [a, b] = await Promise.all([
      f.core.dispatch("storageScan", { ref: f.ref }),
      f.core.dispatch("storageScan", { ref: f.ref }),
    ]);
    for (let i = 0; i < 100 && !f.core.storageAnalysis.stats().channels; i++)
      await pause();
    const state = [f.core.jobs.get(a.id).state, f.core.jobs.get(b.id).state];
    assert(state.includes("queued"));
    f.core.jobs.control(a.id, "cancel");
    await finish(f.core, a.id);
    assert.equal(f.core.jobs.get(a.id).state, "cancelled");
    assert.equal((await finish(f.core, b.id)).state, "completed");
    const rows = await f.core.dispatch("storageSnapshots");
    assert(rows.some((x: any) => x.id === b.id));
    assert.equal(f.core.storageAnalysis.stats().channels, 0);
    assert.equal(f.core.jobs.stats().heldLocks, 0);
  } finally {
    await f.done();
  }
});
test("directory cursors are released only by their owner", async () => {
  const f = await fixture(20);
  try {
    for (let i = 0; i < 30; i++)
      await fs.writeFile(path.join(f.root, String(i)), "x");
    f.core.attachClient("a");
    f.core.attachClient("b");
    const page = await f.core.dispatch("list", { ref: f.ref }, "agent", "a");
    assert(page.cursor);
    await assert.rejects(
      f.core.dispatch(
        "listClose",
        { ref: f.ref, cursor: page.cursor },
        "agent",
        "b",
      ),
      /another client/,
    );
    await f.core.dispatch(
      "listClose",
      { ref: f.ref, cursor: page.cursor },
      "agent",
      "a",
    );
    assert.equal(f.core.directories.stats().clientCursors, 0);
  } finally {
    await f.done();
  }
});
test("retention removes old snapshots and reload queries the disk index", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "file"), "snapshot");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = await f.core.dispatch("storageScan", { ref: f.ref });
      assert.equal((await finish(f.core, j.id)).state, "completed");
      ids.push(j.id);
    }
    const kept = await f.core.storageAnalysis.list();
    assert.equal(kept.length, 3);
    assert(!kept.some((x) => x.id === ids[0]));
    const history = await f.core.dispatch("storageSnapshots", {
      includeUnavailable: true,
    });
    const expired = history.find((x: any) => x.id === ids[0]);
    assert.equal(expired.available, false);
    assert.equal(expired.evictionReason, "snapshot-count");
    await assert.rejects(
      f.core.dispatch("storageResult", { id: ids[0] }),
      /expired/,
    );
    await f.core.dispose();
    const core = new Core(
      path.join(f.dir, "state"),
      path.resolve("helpers/endpoint.py"),
      new Profiler(() => {}),
      { monitorPython: python },
    );
    try {
      await core.init([
        {
          id: "fixture",
          name: "Fixture",
          kind: process.platform === "win32" ? "windows" : "local",
          root: f.dir,
        },
      ]);
      const page = await core.dispatch("storageResult", { id: ids[3] });
      assert.equal(page.directory.files, 1);
      assert.equal(core.storageAnalysis.stats().channels, 0);
    } finally {
      await core.dispose();
    }
  } finally {
    await f.done();
  }
});

test("unreadable directories remain incomplete and never appear as known empty totals", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const f = await fixture();
  const blocked = path.join(f.root, "private");
  try {
    await fs.mkdir(blocked);
    await fs.writeFile(path.join(blocked, "secret"), "fixture");
    await fs.chmod(blocked, 0);
    const j = await f.core.dispatch("storageScan", { ref: f.ref });
    assert.equal((await finish(f.core, j.id)).state, "completed");
    const page = await f.core.dispatch("storageResult", { id: j.id });
    assert(page.snapshot.incomplete);
    assert(page.snapshot.errorCount > 0);
    assert(page.rows[0].errors > 0);
  } finally {
    await fs.chmod(blocked, 0o700);
    await f.done();
  }
});

test("a changed directory is reported while the scanner preserves a partial observation", async () => {
  const f = await fixture();
  const { RemoteEndpoint } = await import("../src/adapters/remote");
  const e = new RemoteEndpoint(
    { id: "driver", kind: "local", name: "Driver", root: f.dir, python },
    path.resolve("helpers/storage.py"),
  );
  try {
    for (let i = 0; i < 250; i++) await fs.mkdir(path.join(f.root, String(i)));
    await e.call("begin", { path: f.root });
    let page = await e.call("page");
    assert(!page.done);
    await fs.writeFile(path.join(f.root, "created-during-scan"), "changed");
    while (!page.done) page = await e.call("page");
    assert(page.snapshot.incomplete);
    assert(
      page.snapshot.errors.some((x: any) =>
        x.error.includes("changed during scan"),
      ),
    );
  } finally {
    await e.dispose();
    await f.done();
  }
});

test("snapshot export includes every directory page and preserves an existing target on failure", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 225; i++) await fs.mkdir(path.join(f.root, String(i)));
    const j = await f.core.dispatch("storageScan", { ref: f.ref });
    await finish(f.core, j.id);
    const target = path.join(f.dir, "export.json");
    await f.core.storageAnalysis.exportTo(j.id, target);
    const data = JSON.parse(await fs.readFile(target, "utf8"));
    assert.equal(data.directories.length, 226);
    await fs.writeFile(target, "retained");
    await assert.rejects(f.core.storageAnalysis.exportTo("missing", target));
    assert.equal(await fs.readFile(target, "utf8"), "retained");
    assert(!(await fs.readdir(f.dir)).some((x) => x.endsWith(".partial")));
    assert.equal(f.core.storageAnalysis.stats().queries, 0);
  } finally {
    await f.done();
  }
});

test("snapshot comparison pages added and removed directories, keeps coverage and rejects another root", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, "old"));
    await fs.writeFile(path.join(f.root, "old", "x"), Buffer.alloc(8192, 3));
    const a = await f.core.dispatch("storageScan", { ref: f.ref });
    assert.equal((await finish(f.core, a.id)).state, "completed");
    await fs.rm(path.join(f.root, "old"), { recursive: true });
    await fs.mkdir(path.join(f.root, "new"));
    await fs.writeFile(path.join(f.root, "new", "x"), Buffer.alloc(16384, 4));
    const b = await f.core.dispatch("storageScan", { ref: f.ref });
    assert.equal((await finish(f.core, b.id)).state, "completed");
    const page = await f.core.dispatch("storageCompare", {
      before: a.id,
      after: b.id,
      limit: 1,
    });
    assert.equal(page.rows.length, 1);
    assert(page.hasMore);
    const next = await f.core.dispatch("storageCompare", {
      before: a.id,
      after: b.id,
      limit: 1,
      offset: 1,
    });
    const all = [...page.rows, ...next.rows];
    assert.deepEqual(all.map((v: any) => v.state).sort(), ["added", "removed"]);
    assert.equal(
      all.reduce((n: number, v: any) => n + v.logicalDelta, 0),
      8192,
    );
    assert.equal(page.incomplete, false);
    const output=path.join(f.dir,"comparison.json");
    await f.core.storageAnalysis.exportTo(b.id,output,a.id);
    const exported=JSON.parse(await fs.readFile(output,"utf8"));
    assert.equal(exported.directories.length,2);
    assert.equal(exported.comparison.before.root, f.root);

    const other = await f.core.dispatch("storageScan", {
      ref: { ...f.ref, path: path.join(f.root, "new") },
    });
    await finish(f.core, other.id);
    await assert.rejects(
      f.core.dispatch("storageCompare", { before: b.id, after: other.id }),
      /same endpoint and scan root/,
    );
    assert.equal(f.core.storageAnalysis.stats().channels, 0);
    assert.equal(f.core.storageAnalysis.stats().queries, 0);
  } finally {
    await f.done();
  }
});

test("oversized snapshot retains a bounded tombstone explaining budget eviction", async () => {
  const f = await fixture();
  try {
    const j = await f.core.dispatch("storageScan", { ref: f.ref });
    await finish(f.core, j.id);
    const file = path.join(f.dir, "state", "storage-scans", j.id + ".json");
    const meta = JSON.parse(await fs.readFile(file, "utf8"));
    meta.bytes = 101 * 2 ** 20;
    await fs.writeFile(file, JSON.stringify(meta));
    await f.core.dispatch("storageResult", { id: j.id });
    assert.equal((await f.core.dispatch("storageSnapshots")).length, 0);
    const history = await f.core.dispatch("storageSnapshots", {
      includeUnavailable: true,
    });
    assert.equal(history[0].evictionReason, "snapshot-over-budget");
    await assert.rejects(
      f.core.dispatch("storageResult", { id: j.id }),
      /expired/,
    );
  } finally {
    await f.done();
  }
});
