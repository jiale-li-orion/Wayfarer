import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "workspace-map-lifecycle-"),
);
const results: any = {
  environment: { node: process.version, platform: process.platform },
  events: [],
};
const core = new Core(
  path.join(root, "state"),
  path.resolve("helpers/endpoint.py"),
  new Profiler((s) => {
    const e = JSON.parse(s);
    if (["job.start", "job.end"].includes(e.stage)) results.events.push(e);
  }),
);
const a = path.join(root, "a"),
  b = path.join(root, "b");
await fs.mkdir(a);
await fs.mkdir(b);
await core.init([
  { id: "a", kind: "local", name: "a", root: a },
  { id: "b", kind: "local", name: "b", root: b },
]);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  for (let n = 0; n < 600; n++)
    await fs.writeFile(path.join(a, `item-${n}.txt`), "fixture");
  const endpoint = core.endpoints.get("a"),
    original = endpoint.call.bind(endpoint);
  let release!: () => void;
  let responded!: () => void;
  const response = new Promise<void>((r) => (responded = r)),
    gate = new Promise<void>((r) => (release = r));
  endpoint.call = async (method, args) => {
    const value = await original(method, args);
    if (method === "list") {
      responded();
      await gate;
    }
    return value;
  };
  core.directories.watch([{ endpoint: "a", path: a }]);
  const pending = core.directories.list(
    { endpoint: "a", path: a },
    undefined,
    true,
  );
  await response;
  core.directories.watch([]);
  release();
  await pending;
  await pause(50);
  results.cursorAfterCollapse = await original("resources");
  endpoint.call = original;
  for (const file of ["one.bin", "two.bin"]) {
    const f = await fs.open(path.join(a, file), "w");
    await f.truncate(64 * 1024 * 1024);
    await f.close();
  }
  const cases = [];
  for (let round = 0; round < 3; round++)
    for (const conflict of ["overwrite", "rename"]) {
      const cpu = process.cpuUsage(),
        mem = process.memoryUsage(),
        start = performance.now();
      let peak = mem.rss,
        maxRunning = 0;
      const latency: number[] = [];
      const jobs = await Promise.all(
        ["one.bin", "two.bin"].map((file) =>
          core.dispatch("transfer", {
            sources: [{ endpoint: "a", path: path.join(a, file) }],
            target: { endpoint: "b", path: b },
            mode: "copy",
            conflict,
          }),
        ),
      );
      while (jobs.some((j) => ["queued", "running"].includes(j.state))) {
        maxRunning = Math.max(
          maxRunning,
          jobs.filter((j) => j.state === "running").length,
        );
        peak = Math.max(peak, process.memoryUsage().rss);
        const t = performance.now();
        const page = await core.directories.list(
          { endpoint: "a", path: a },
          undefined,
          true,
          "agent",
        );
        if (page.cursor)
          await endpoint.call("scanClose", { cursor: page.cursor });
        latency.push(performance.now() - t);
        await pause(10);
      }
      if (jobs.some((j) => j.state !== "completed"))
        throw Error(JSON.stringify(jobs));
      const delta = process.cpuUsage(cpu);
      latency.sort((x, y) => x - y);
      cases.push({
        round,
        conflict,
        wallMs: performance.now() - start,
        cpuMs: (delta.user + delta.system) / 1000,
        peakRss: peak,
        rssStart: mem.rss,
        maxRunning,
        browseP95Ms: latency[Math.floor(latency.length * 0.95)],
        browseCount: latency.length,
      });
    }
  results.transfers = cases;
  const cycles = [];
  for (let round = 0; round < 8; round++) {
    const cpu = process.cpuUsage(),
      start = performance.now();
    for (let n = 0; n < 20; n++) {
      core.directories.watch([{ endpoint: "a", path: a }]);
      await core.directories.list({ endpoint: "a", path: a }, undefined, true);
      core.directories.watch([]);
    }
    await pause(50);
    const d = process.cpuUsage(cpu);
    const naturalMemory = process.memoryUsage();
    global.gc?.();
    cycles.push({
      round,
      wallMs: performance.now() - start,
      cpuMs: (d.user + d.system) / 1000,
      naturalMemory,
      memory: process.memoryUsage(),
      resources: await endpoint.call("resources"),
    });
  }
  results.browseCycles = cycles;
  const { Directories } = await import("../src/core/directories");
  const dirs = new Directories(core.endpoints, core.profile);
  let changes = 0;
  dirs.on("change", () => changes++);
  const start = performance.now();
  for (let i = 0; i < 600; i++) dirs.invalidate({ endpoint: "a", path: a });
  await pause(250);
  results.burst = {
    invalidations: 600,
    events: changes,
    wallMs: performance.now() - start,
  };
  dirs.dispose();
  console.log(
    JSON.stringify({
      cursorAfterCollapse: results.cursorAfterCollapse.cursors,
      transfers: results.transfers,
      burst: results.burst,
    }),
  );
  await fs.mkdir("artifacts", { recursive: true });
  await fs.writeFile(
    process.argv[2] || "artifacts/profile-lifecycle-core.json",
    JSON.stringify(results, null, 2),
  );
} finally {
  await core.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
