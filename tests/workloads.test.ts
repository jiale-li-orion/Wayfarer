import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workloads } from "../src/core/workloads";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";

test("parallel registrations preserve rank/segment files, pagination and map ownership", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-workloads-"));
  try {
    const file = path.join(dir, "catalog.json");
    const open = async () => {
      const s = new Workloads(file, () => true);
      await s.init();
      return s;
    };
    const s = await open();
    const input = { runId: "training", endpoint: "host" };
    await Promise.all(
      [0, 1].map((rank) =>
        s.register({
          ...input,
          files: [
            {
              kind: "model",
              endpoint: "host",
              path: "/runs/" + rank + "/a/run.json",
            },
          ],
        }),
      ),
    );
    await s.register({
      ...input,
      files: [
        { kind: "model", endpoint: "host", path: "/runs/0/b/run.json" },
        { kind: "profile", endpoint: "host", path: "/time.json" },
      ],
    });
    await s.register({ ...input, step: 3 });
    await s.register({ ...input, runId: "eval" });
    assert.equal((await open()).get("training").files.length, 4);
    const page = await s.page(undefined, 1);
    assert.equal((await s.page(page.cursor, 1)).items[0].runId, "training");
    await assert.rejects(s.register({ ...input, endpoint: "another" }));
    const artifact = path.join(dir, "keep");
    await fs.writeFile(artifact, "kept");
    await s.register({
      ...input,
      files: [{ kind: "artifact", endpoint: "host", path: artifact }],
    });
    await s.forget(input.runId);
    assert.equal(await fs.readFile(artifact, "utf8"), "kept");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("batch observation distinguishes offline, PID reuse and explicit exit; stale replies cannot resurrect a forgotten run", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-process-"));
  try {
    const store = new Workloads(path.join(dir, "runs.json"), () => true);
    for (const pid of [10, 11])
      await store.register({
        runId: "run" + pid,
        endpoint: "lab",
        process: { pid, identity: pid + ":1", bootId: "first" },
      });
    let calls = 0;
    await store.page(undefined, 10, async (ep, pids) => {
      calls++;
      assert.deepEqual(pids, [10, 11]);
      return {
        status: "online",
        bootId: "first",
        identities: { 10: "10:1", 11: "11:1" },
      };
    });
    assert.equal(calls, 1);
    const offline = await store.page(undefined, 10, async () => ({
      status: "offline",
    }));
    assert(
      offline.items.every(
        (w) => w.observed === "alive" && w.connection === "offline",
      ),
    );
    await store.page(undefined, 10, async () => ({
      status: "online",
      bootId: "second",
      identities: { 10: "10:1", 11: null },
    }));
    assert.equal(store.get("run10").observed, "changed");
    await store.register({ runId: "run11", endpoint: "lab", state: "failed" });
    assert.equal(store.get("run11").state, "failed");
    await store.register({
      runId: "pending",
      endpoint: "lab",
      process: { pid: 99, identity: "99:1" },
    });
    await store.page(undefined, 10, async () => {
      await store.forget("pending");
      return { status: "online", identities: { 99: "99:1" } };
    });
    assert.throws(() => store.get("pending"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("a real map reads producer status, preserves terminal facts and filters independent transfers before paging", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-run-map-"));
  const core = new Core(
    path.join(dir, "map"),
    path.resolve("helpers/endpoint.py"),
    new Profiler(() => {}),
  );
  try {
    await core.init([
      { id: "fixture", name: "fixture", kind: "local", root: dir },
    ]);
    const statusPath = path.join(dir, "status.json");
    const runId = "real-run",
      endpoint = "fixture";
    await core.dispatch("workloadRegister", { runId, endpoint, statusPath });
    await fs.writeFile(
      statusPath,
      JSON.stringify({
        runId,
        phase: "评测",
        step: 17,
        state: "completed",
        updated: Date.now(),
      }),
    );
    const observed = await core.dispatch("workloadDetail", {
      runId,
      observe: true,
    });
    assert.equal(observed.state, "completed");
    assert.equal(observed.step, 17);
    await fs.mkdir(path.join(dir, "to"));
    for (let i = 0; i < 3; i++) {
      const source = path.join(dir, "input" + i);
      await fs.writeFile(source, "payload");
      const j = await core.dispatch("transfer", {
        operationId: "transfer" + i,
        workloadId: i === 1 ? undefined : runId,
        workloadPhase: i === 1 ? undefined : "产物",
        sources: [{ endpoint, path: source }],
        target: { endpoint, path: path.join(dir, "to") },
        mode: "copy",
        conflict: "skip",
      });
      for (let n = 0; n < 200 && core.jobs.get(j.id).state !== "completed"; n++)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(core.jobs.get(j.id).state, "completed");
    }
    const filtered = await core.dispatch("jobsPage", {
      kind: "transfer",
      workloadId: runId,
      limit: 1,
    });
    assert.equal(filtered.total, 2);
    assert.equal(filtered.history[0].workloadPhase, "产物");
    assert.equal(
      (
        await core.dispatch("jobsPage", {
          kind: "transfer",
          workloadId: runId,
          cursor: filtered.cursor,
        })
      ).history.length,
      1,
    );
    assert.equal(
      (await core.dispatch("jobsPage", { kind: "transfer" })).total,
      3,
    );
    await core.dispatch("workloadForget", { runId });
    assert.equal(
      (await core.dispatch("jobsPage", { kind: "transfer" })).total,
      3,
    );
  } finally {
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
