import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
import { parseWslBudget } from "../src/core/wslBudget";
import { Workloads } from "../src/core/workloads";

test("declared WSL budgets are separate from runtime readings", () => {
  assert.deepEqual(
    parseWslBudget(
      "\uFEFF[wsl2]\r\nmemory=10GB # host policy\n[other]\nprocessors=9",
    ),
    { source: "configured", memory: "10GB" },
  );
  assert.deepEqual(parseWslBudget("[wsl2]\nprocessors=6\nswap=0"), {
    source: "configured",
    processors: 6,
    swap: "0",
  });
  assert.equal(
    parseWslBudget("[wsl2]\nnetworkingMode=mirrored").source,
    "default",
  );
});

test("process heartbeats and repeated producer steps preserve the last real progress timestamp", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-progress-"));
  try {
    const w = new Workloads(path.join(dir, "catalog.json"), () => true);
    const base = {
      runId: "abc",
      endpoint: "test",
      process: { pid: 12, identity: "12:7" },
      statusPath: "/test/status.json",
    };
    await w.register(base);
    for (const [updated, step, progress] of [
      [1000, 5, 1000],
      [1100, 5, 1000],
      [1200, 6, 1200],
    ]) {
      await w.page(undefined, 10, async () => ({
        status: "online",
        stamp: Date.now(),
        identities: { 12: "12:7" },
        reports: {
          "/test/status.json": { runId: "abc", updated, step, phase: "训练" },
        },
      }));
      assert.equal(w.get("abc").progressAt, progress);
    }
    await w.register({ ...base, step: 6 });
    assert.equal(w.get("abc").progressAt, 1200);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reopened maps merge an offline index once, preserve historic rows and honour forget", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-index-"));
  let core: Core | undefined;
  const ep = "test",
    ref = { endpoint: ep, path: dir };
  const open = async () => {
    const c = new Core(
      path.join(dir, "state"),
      path.resolve("helpers/endpoint.py"),
      new Profiler(() => {}),
    );
    await c.init([
      {
        id: ep,
        name: ep,
        kind: process.platform === "win32" ? "windows" : "local",
        root: dir,
      },
    ]);
    return c;
  };
  try {
    core = await open();
    await core.dispatch("registerProject", { ref });
    await core.dispatch("workloadRegister", {
      runId: "previous",
      endpoint: ep,
    });
    await core.dispose();
    const index = path.join(dir, ".wayfarer", "runs");
    await fs.mkdir(index, { recursive: true });
    const entry = path.join(
      index,
      createHash("sha256").update("new").digest("hex") + ".json",
    );
    const data = {
      schema: "wayfarer.run/1",
      runId: "new",
      files: [
        { kind: "model", path: "run.json" },
        { kind: "log", path: "run.log" },
      ],
    };
    await fs.writeFile(entry, JSON.stringify(data));
    await fs.writeFile(path.join(index, "ignored.part"), "{");
    core = await open();
    const list = await core.dispatch("workloadsPage", { observe: false });
    assert.equal(list.total, 2);
    const detail = await core.dispatch("workloadDetail", { runId: "new" });
    assert.deepEqual(detail.projectRef, ref);
    assert.equal(detail.files[0].path, path.join(dir, "run.json"));
    await core.dispatch("workloadRegister", {
      endpoint: ep,
      runId: "new",
      phase: "after",
      step: 2,
    });
    await core.dispose();
    core = await open();
    assert.equal(
      (await core.dispatch("workloadDetail", { runId: "new" })).step,
      2,
    );
    await core.dispatch("workloadForget", { runId: "new" });
    await core.dispose();
    core = await open();
    assert.equal(
      (await core.dispatch("workloadsPage", { observe: false })).total,
      1,
    );
    assert.equal(JSON.parse(await fs.readFile(entry, "utf8")).runId, "new");
  } finally {
    await core?.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("recordings support field projection and bounded time windows; export publishes a new verified file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-agent-records-"));
  const core = new Core(
    path.join(dir, "map"),
    path.resolve("helpers/endpoint.py"),
    new Profiler(() => {}),
  );
  try {
    await core.init([
      {
        id: "test",
        name: "test",
        kind: process.platform === "win32" ? "windows" : "local",
        root: dir,
      },
    ]);
    const id = "12345-abcdef12-1234-1234-1234-123456789abc.jsonl",
      root = core.monitor.recordingDirectory();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, id),
      [1, 2, 3]
        .map((stamp) =>
          JSON.stringify({
            stamp,
            section: "summary",
            endpoint: "test",
            system: { cpuPercent: stamp },
          }),
        )
        .join("\n") + "\n",
    );
    const first = await core.dispatch("recordingRead", {
      id,
      from: 2,
      to: 3,
      fields: ["stamp", "cpuPercent"],
      limit: 1,
    });
    assert.deepEqual(first.items, [{ stamp: 2, cpuPercent: 2 }]);
    assert(first.hasMore);
    const last = await core.dispatch("recordingRead", {
      id,
      cursor: first.cursor,
      to: 3,
      fields: ["stamp"],
    });
    assert.deepEqual(last.items, [{ stamp: 3 }]);
    assert(
      (
        await core.dispatch("recordingControl", { action: "list" })
      ).recordings.includes(id),
    );
    await assert.rejects(
      core.dispatch("recordingRead", { id: "../etc/passwd" }),
    );
    const target = { endpoint: "test", path: path.join(dir, "report.csv") };
    const input = {
      target,
      source: { kind: "recording", id },
      format: "csv",
      operationId: "one",
    };
    async function finish(input: any) {
      const j = await core.dispatch("artifactExport", input);
      for (
        let i = 0;
        i < 150 && ["queued", "running"].includes(core.jobs.get(j.id).state);
        i++
      )
        await new Promise((r) => setTimeout(r, 10));
      return core.jobs.details(j.id);
    }
    const one = await finish(input);
    assert.equal(one.state, "completed", one.error);
    const content = await fs.readFile(target.path);
    assert.equal(
      one.result.sha256,
      createHash("sha256").update(content).digest("hex"),
    );
    assert.equal((await core.dispatch("artifactExport", input)).id, one.id);
    const two = await finish({ ...input, operationId: "two" });
    assert.equal(two.state, "failed");
    assert.deepEqual(await fs.readFile(target.path), content);
    assert(!(await fs.readdir(dir)).some((n) => n.endsWith(".part")));
  } finally {
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("cancel a multi-chunk SSH-style export after writing a partial block", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-export-cancel-"));
  const core = new Core(
    path.join(dir, "map"),
    path.resolve("helpers/endpoint.py"),
    new Profiler(() => {}),
  );
  try {
    await core.init([
      {
        id: "test",
        name: "test",
        kind: process.platform === "win32" ? "windows" : "local",
        root: dir,
      },
    ]);
    const id = "12345-abcdef12-2345-5678-1234-123456789abc.jsonl",
      root = core.monitor.recordingDirectory();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, id),
      Array.from({ length: 600 }, (_, stamp) =>
        JSON.stringify({
          stamp,
          endpoint: "test",
          section: "summary",
          system: { memory: { scope: "x".repeat(1200) } },
        }),
      ).join("\n") + "\n",
    );
    const ep = core.endpoints.get("test"),
      original = ep.call.bind(ep);
    let release!: () => void, signal!: () => void;
    const ready = new Promise<void>((ok) => (signal = ok)),
      gate = new Promise<void>((ok) => (release = ok));
    ep.call = async (method, a) => {
      const result = await original(method, a);
      if (method === "write" && a?.data) {
        signal();
        await gate;
      }
      return result as any;
    };
    const target = { endpoint: "test", path: path.join(dir, "cancel.json") };
    const job = await core.dispatch("artifactExport", {
      source: { kind: "recording", id },
      target,
      operationId: "cancel-me",
    });
    try {
      await ready;
      await core.dispatch("jobControl", { id: job.id, action: "cancel" });
    } finally {
      release();
    }
    for (let i = 0; i < 200 && core.jobs.get(job.id).state !== "cancelled"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(core.jobs.get(job.id).state, "cancelled");
    assert(
      !(await fs.readdir(dir)).some(
        (n) => n.endsWith(".part") || n === "cancel.json",
      ),
    );
  } finally {
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
