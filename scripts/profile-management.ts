import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const source = process.env.WM_SOURCE ?? process.cwd();
const { Core } = await import(path.join(source, "src/core/core.ts"));
const { Profiler } = await import(path.join(source, "src/core/log.ts"));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-management-profile-"));
const state = path.join(root, "state"),
  dir = path.join(state, "jobs");
await fs.mkdir(dir, { recursive: true });
const times = () => ({
  cpu: process.cpuUsage(),
  memory: process.memoryUsage(),
});
const result: any = { source, node: process.version, historyTasks: 3000 };
try {
  for (let n = 0; n < 3000; n++)
    await fs.writeFile(
      path.join(dir, "fixture-" + n + ".json"),
      JSON.stringify({
        id: "fixture-" + n,
        kind: "size",
        state: "completed",
        created: 1700000000000 + n,
        updated: 1700000000000 + n,
        bytes: n,
        files: 1,
        input: { ref: { endpoint: "a", path: root } },
        checkpoint: {},
        logs: [],
        result: { bytes: n },
      }),
    );
  for (let iteration = 0; iteration < 2; iteration++) {
    global.gc?.();
    const before = times(),
      start = performance.now();
    const core = new Core(
      state,
      path.join(source, "helpers/endpoint.py"),
      new Profiler(() => {}),
    );
    await core.init([{ id: "a", kind: "local", root, name: "fixture" }]);
    const initMs = performance.now() - start;
    global.gc?.();
    const after = times();
    let page;
    const pageStart = performance.now();
    try {
      page = await core.dispatch("jobsPage", { limit: 30 });
    } catch {
      page = await core.dispatch("jobs");
    }
    const pageMs = performance.now() - pageStart;
    const listings = [];
    for (let i = 0; i < 30; i++) {
      const st = performance.now();
      await core.dispatch("list", {
        ref: { endpoint: "a", path: root },
        refresh: true,
      });
      listings.push(performance.now() - st);
    }
    listings.sort((a, b) => a - b);
    result[iteration ? "warm" : "cold"] = {
      initMs,
      heapDelta: after.memory.heapUsed - before.memory.heapUsed,
      rss: after.memory.rss,
      cpuMs:
        (after.cpu.user -
          before.cpu.user +
          after.cpu.system -
          before.cpu.system) /
        1000,
      residentTasks: core.jobs.records.size,
      pageRows: Array.isArray(page) ? page.length : page.history.length,
      pageMs,
      summaryBytes: Buffer.byteLength(JSON.stringify(page)),
      directoryP95Ms: listings[Math.floor(listings.length * 0.95)],
    };
    if (iteration && core.inspector) {
      let calls = 0;
      const e = core.endpoints.get("a"),
        original = e.call.bind(e);
      e.call = (...args: any[]) => {
        calls++;
        return original(...args);
      };
      const st = performance.now();
      await Promise.all(
        Array.from({ length: 20 }, () =>
          core.dispatch("inspect", { ref: { endpoint: "a", path: root } }),
        ),
      );
      const firstCalls = calls;
      for (let n = 0; n < 200; n++)
        await core.dispatch("inspect", { ref: { endpoint: "a", path: root } });
      result.inspection = {
        ms: performance.now() - st,
        initialCalls: firstCalls,
        repeatCalls: calls - firstCalls,
        stats: core.inspector.stats(),
      };
    }
    await core.dispose();
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
