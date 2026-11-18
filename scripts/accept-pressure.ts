import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
import { CapacityRefresh } from "../src/core/capacityRefresh";
async function main() {
  const root = path.resolve(process.argv[2]),
    helper = path.join(root, "helpers", "endpoint.py");
  const fixture = await fs.mkdtemp(path.join(root, "fixture-"));
  const logs: any[] = [];
  const core = new Core(
    path.join(fixture, "state"),
    helper,
    new Profiler((s) => logs.push(JSON.parse(s))),
    {
      monitorPython: process.argv[3],
      resourceRecordingDirectory: path.join(fixture, "records"),
    },
  );
  const source = path.join(fixture, "中文 source");
  await fs.mkdir(source);
  try {
    await core.init(
      process.argv[4]
        ? JSON.parse(await fs.readFile(process.argv[4], "utf8"))
        : [],
    );
    const configs = core.endpoints.configs();
    const native = configs.find(
      (c) =>
        c.kind === (process.platform === "win32" ? "windows" : "local") &&
        source.toLowerCase().startsWith(c.root.toLowerCase()),
    )!;
    const ref = { endpoint: native.id, path: source };
    await fs.mkdir(path.join(source, "old"));
    await fs.writeFile(path.join(source, "old", "x"), Buffer.alloc(8192));
    const scan = async () => {
      const j = await core.dispatch("storageScan", { ref });
      while (["running", "queued"].includes(core.jobs.get(j.id).state))
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(core.jobs.get(j.id).state, "completed");
      return j.id;
    };
    const before = await scan();
    await fs.rm(path.join(source, "old"), { recursive: true });
    await fs.mkdir(path.join(source, "new"));
    await fs.writeFile(path.join(source, "new", "x"), Buffer.alloc(16384));
    const after = await scan();
    const diff = await core.dispatch("storageCompare", { before, after });
    assert.deepEqual(diff.rows.map((r: any) => r.state).sort(), [
      "added",
      "removed",
    ]);
    let refreshes = 0;
    const capacity = new CapacityRefresh(
      (r) => core.storageAnalysis.probe(r),
      () => refreshes++,
      (e) => {
        throw Error(e);
      },
      1,
    );
    const first = process.memoryUsage();
    for (let i = 0; i < 50; i++) {
      capacity.watch(ref);
      capacity.watch();
    }
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(refreshes, 0);
    capacity.dispose();
    const samples: any[] = [];
    for (const m of core.monitor.machines()) {
      const value = await core.monitor.snapshot({
        endpoint: m.endpoint,
        section: "summary",
      });
      assert.equal(value.status, "online");
      if (m.kind === "windows") {
        assert(value.system.memory.commitLimit > 0);
        assert(value.system.storage.volumes.length > 0);
      }
      if (m.kind === "wsl") {
        assert(value.system.pressure);
        assert(value.physicalBudget);
      }
      samples.push(value);
    }
    for (let i = 0; i < 50; i++) {
      core.monitor.watch("acceptance", {});
      await new Promise((r) => setTimeout(r, 15));
      core.monitor.watch("acceptance");
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(core.monitor.stats().readers, 0);
    assert.equal(core.monitor.stats().timer, false);
    for (let i = 0; i < 200 && core.monitor.stats().pending; i++)
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(core.monitor.stats().channels, 0);
    const result = {
      stamp: Date.now(),
      platform: process.platform,
      comparison: diff,
      samples,
      first,
      last: process.memoryUsage(),
      monitor: core.monitor.stats(),
      storage: core.storageAnalysis.stats(),
      logs: logs.filter((l) => l.stage === "monitor.sample"),
    };
    await fs.writeFile(
      path.join(root, "acceptance.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      JSON.stringify({
        samples: samples.map((s) => ({ name: s.name, status: s.status })),
        monitor: result.monitor,
        storage: result.storage,
      }),
    );
  } finally {
    await core.dispose();
    await fs.rm(fixture, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
