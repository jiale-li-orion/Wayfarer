import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SystemMonitor } from "../src/core/monitor";
import { Profiler } from "../src/core/log";
import { csvRows, csvHeader } from "../src/core/resourceExport";
import type { EndpointConfig } from "../src/shared/types";
const endpoints: EndpointConfig[] = [
  { id: "c", name: "C", kind: "windows", root: "C:\\" },
  { id: "d", name: "D", kind: "windows", root: "D:\\" },
  {
    id: "train",
    name: "Train",
    kind: "ssh",
    root: "/home/user",
    host: "train",
  },
];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-monitor-"));
  let calls = 0,
    live = 0,
    peak = 0,
    closed = 0;
  const monitor = new SystemMonitor(
    () => endpoints,
    "unused",
    dir,
    new Profiler(() => {}),
    undefined,
    () => {
      live++;
      peak = Math.max(live, peak);
      let disposed = false;
      return {
        async call<T>(_method: string, a: any) {
          calls++;
          await pause(10);
          return {
            stamp: Date.now(),
            system: { cpuPercent: 2, memory: { used: 1, total: 2 } },
            gpus: [],
            _baseline: { system: [10, 8] },
            section: a.section,
          } as T;
        },
        async dispose() {
          if (!disposed) {
            disposed = true;
            live--;
            closed++;
          }
        },
        abort() {},
      };
    },
  );
  return {
    monitor,
    dir,
    stats: () => ({ calls, live, peak, closed }),
    async done() {
      await monitor.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
test("Windows disks share one target; Agent one-off starts no timer and releases collector", async () => {
  const f = await fixture();
  try {
    assert.equal(f.monitor.machines().length, 2);
    assert.equal(f.monitor.machines()[0].roots.length, 2);
    const initial = await f.monitor.snapshot();
    assert.equal(initial.snapshots.length, 0);
    assert.equal(f.stats().calls, 0);
    const [c, d] = await Promise.all([
      f.monitor.snapshot({ endpoint: "c" }),
      f.monitor.snapshot({ endpoint: "d" }),
    ]);
    assert.equal(c, d);
    assert.equal(f.stats().calls, 1);
    await pause(1);
    assert.equal(f.stats().live, 0);
    assert.equal(f.monitor.stats().timer, false);
  } finally {
    await f.done();
  }
});
test("identical concurrent requests merge and different sections never overlap a machine", async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.monitor.snapshot({ endpoint: "train", section: "processes" }),
      f.monitor.snapshot({ endpoint: "train", section: "processes" }),
    ]);
    assert.equal(a, b);
    assert.equal(f.stats().calls, 1);
    await Promise.all([
      f.monitor.snapshot({ endpoint: "train", section: "gpus" }),
      f.monitor.snapshot({ endpoint: "train", section: "io" }),
    ]);
    assert.equal(f.stats().peak, 1);
    assert.equal(f.stats().calls, 3);
    assert.equal("_baseline" in a, false);
  } finally {
    await f.done();
  }
});
test("50 view subscriptions release timer, channels and requests; recording survives hiding", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 50; i++) {
      f.monitor.watch("page", { endpoint: "c", section: "gpus" });
      await pause(25);
      f.monitor.watch("page");
      await pause(1);
    }
    await pause(50);
    assert.equal(f.monitor.stats().readers, 0);
    assert.equal(f.monitor.stats().timer, false);
    assert.equal(f.stats().live, 0);
    assert.equal(f.monitor.stats().pending, 0);
    const rec = await f.monitor.startRecording();
    assert.equal(f.monitor.stats().timer, true);
    await pause(40);
    f.monitor.watch("page");
    assert.equal(f.monitor.stats().recording, true);
    await f.monitor.stopRecording();
    await pause(20);
    assert.equal(f.monitor.stats().timer, false);
    assert.equal(f.stats().live, 0);
    const lines = (await fs.readFile(rec.file, "utf8")).trim().split("\n");
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => !JSON.parse(l).history));
  } finally {
    await f.done();
  }
});
test("offline machine returns its own status and other machine remains usable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-monitor-offline-"));
  const monitor = new SystemMonitor(
    () => endpoints,
    "unused",
    dir,
    new Profiler(() => {}),
    undefined,
    (c) => ({
      async call<T>() {
        if (c.id === "train") throw Error("offline");
        return { stamp: Date.now(), system: {}, gpus: [] } as T;
      },
      async dispose() {},
      abort() {},
    }),
  );
  try {
    assert.equal(
      (await monitor.snapshot({ endpoint: "train" })).status,
      "offline",
    );
    assert.equal((await monitor.snapshot({ endpoint: "c" })).status, "online");
  } finally {
    await monitor.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("CSV preserves memory units, quotes names and neutralizes spreadsheet formulas", () => {
  const csv =
    csvHeader +
    csvRows({
      stamp: 1,
      name: "Train",
      system: { cpuPercent: 10, logicalCpus: 8, memory: { used: 1024 } },
      processes: [{ pid: 2, name: '=evil,"x"', rss: 100 }],
      gpus: [{ id: "a", name: "GPU", memoryUsed: 20, memoryTotal: 30 }],
    });
  assert.match(csv, /rssBytes,pssBytes,privateBytes/);
  assert.match(csv, /'=evil,""x""/);
  assert.match(csv, /"10"/);
});

test("rapid tab changes keep one in-flight UI sample and discard old interests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-monitor-slow-"));
  let calls = 0;
  let unblock!: () => void;
  const held = new Promise<void>((r) => (unblock = r));
  const monitor = new SystemMonitor(
    () => [endpoints[0]],
    "unused",
    dir,
    new Profiler(() => {}),
    undefined,
    () => ({
      async call<T>() {
        calls++;
        await held;
        return { stamp: Date.now(), system: {}, gpus: [] } as T;
      },
      async dispose() {},
      abort() {},
    }),
  );
  try {
    monitor.watch("page", { endpoint: "c", section: "processes" });
    await pause(1);
    for (let i = 0; i < 50; i++)
      monitor.watch("page", { endpoint: "c", section: i % 2 ? "gpus" : "io" });
    await pause(1);
    assert.equal(calls, 1);
    assert.equal(monitor.stats().pending, 1);
    monitor.watch("page");
    unblock();
    await pause(20);
    assert.equal(calls, 1);
    assert.equal(monitor.stats().channels, 0);
    assert.equal(monitor.stats().timer, false);
  } finally {
    unblock();
    await monitor.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("real collector isolates an exited PID and keeps the read-only transport usable", async () => {
  const { RemoteEndpoint } = await import("../src/adapters/remote");
  const collector = new RemoteEndpoint(
    { id: "monitor-test", name: "test", kind: "local", root: os.tmpdir() },
    path.resolve("helpers/monitor.py"),
  );
  try {
    const missing: any = await collector.call("snapshot", {
      section: "process",
      pid: 2147483647,
    });
    assert.equal(missing.detailStatus, "exited");
    const stale: any = await collector.call("snapshot", {
      section: "summary",
      _baseline: { system: [0, 0, Date.now() / 1000 - 60] },
    });
    assert.equal(stale.system.cpuPercent, null);
    assert.equal(missing.detail, null);
    assert.ok(missing.system.memory.total > 0);
    await assert.rejects(
      () => collector.call("execStart", { argv: ["echo", "forbidden"] }),
      /Read-only/,
    );
    const summary: any = await collector.call("snapshot", {
      section: "summary",
    });
    assert.ok(summary.system.memory.total > 0);
  } finally {
    await collector.dispose();
  }
});

test("GPU detail reports per-device process memory while process pages report its total", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const script = `import importlib.util,os
s=importlib.util.spec_from_file_location('monitor',${JSON.stringify(path.resolve("helpers/monitor.py"))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.gpu_query=lambda apps=False: ([{'id':'a'},{'id':'b'}],[{'gpu':'a','pid':os.getpid(),'memoryUsed':100},{'gpu':'b','pid':os.getpid(),'memoryUsed':200}],[])
a=m.snapshot({'section':'gpu','gpu':'a'});assert next(p for p in a['processes'] if p['pid']==os.getpid())['gpuMemory']==100
b=m.snapshot({'section':'processes','search':str(os.getpid())});assert next(p for p in b['processes'] if p['pid']==os.getpid())['gpuMemory']==300
if m.NVML:m.NVML.close()
if m.WIN:m.PDH.close()
print('scoped GPU memory verified')`;
  const { stdout } = await promisify(execFile)(
    process.platform === "win32" ? "python" : "python3",
    ["-c", script],
  );
  assert.match(stdout, /scoped GPU memory verified/);
});

test("shutdown waits for a collector already retiring after the view was hidden", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-monitor-retire-"));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const monitor = new SystemMonitor(
    () => [endpoints[0]],
    "unused",
    dir,
    new Profiler(() => {}),
    undefined,
    () => ({
      async call<T>() {
        return { stamp: Date.now(), system: {}, gpus: [] } as T;
      },
      async dispose() {
        await gate;
      },
      abort() {},
    }),
  );
  let finished = false;
  let closing: Promise<void> | undefined;
  try {
    await monitor.snapshot({ endpoint: "c" });
    await pause(1);
    assert.equal(monitor.stats().retiringChannels, 1);
    closing = monitor.dispose().then(() => {
      finished = true;
    });
    await pause(5);
    assert.equal(finished, false);
    release();
    await closing;
    assert.equal(monitor.stats().retiringChannels, 0);
  } finally {
    release();
    await closing;
    await monitor.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
