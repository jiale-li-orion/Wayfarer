import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
// Run through tsx so the benchmark uses the exact product Core and task scheduler.
const { Core } = await import("../src/core/core.ts");
const { Profiler } = await import("../src/core/log.ts");
const output = path.resolve(process.argv[2]);
await fs.mkdir(output, { recursive: true });
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "wm-storage-profile-"));
const root = path.join(fixture, "million");
await fs.mkdir(root);
const count = Number(process.env.WM_STORAGE_FILES ?? 1000000);
const python = process.env.WM_TEST_PYTHON ?? "python3";
execFileSync(python, [
  "-c",
  `import os,sys
root=sys.argv[1];count=int(sys.argv[2])
for i in range((count+999)//1000):
 d=os.path.join(root,str(i));os.mkdir(d)
 for j in range(min(1000,count-i*1000)):
  fd=os.open(os.path.join(d,str(j)),os.O_CREAT|os.O_WRONLY,0o600);os.close(fd)
`,
  root,
  String(count),
]);
const logs = [];
const core = new Core(
  path.join(fixture, "state"),
  path.resolve("helpers/endpoint.py"),
  new Profiler((s) => logs.push(JSON.parse(s))),
  { monitorPython: python },
);
const ref = { endpoint: "fixture", path: root };
let results = { files: count };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(method, ref) {
  const start = performance.now(),
    cpu = process.cpuUsage();
  const j = await core.dispatch(method, { ref });
  let peak = process.memoryUsage().rss,
    latencies = [];
  while (["running", "queued"].includes(core.jobs.get(j.id).state)) {
    peak = Math.max(peak, process.memoryUsage().rss);
    const at = performance.now();
    await core.dispatch("list", {
      ref: { endpoint: "fixture", path: fixture },
      refresh: true,
    });
    latencies.push(performance.now() - at);
    await sleep(20);
  }
  const end = process.cpuUsage(cpu);
  latencies.sort((a, b) => a - b);
  if (core.jobs.get(j.id).state !== "completed")
    throw Error(JSON.stringify(core.jobs.get(j.id)));
  return {
    id: j.id,
    elapsedMs: performance.now() - start,
    cpuMs: (end.user + end.system) / 1000,
    peakHostRss: peak,
    directoryP50: latencies[Math.floor(latencies.length * 0.5)],
    directoryP95: latencies[Math.floor(latencies.length * 0.95)],
    job: await core.dispatch("job", {
      id: j.id,
      fields: ["summary", "result"],
    }),
  };
}
try {
  await core.init([
    { id: "fixture", name: "Fixture", kind: "local", root: fixture },
  ]);
  results.million = await run("storageScan", ref);
  const page = await core.dispatch("storageResult", {
    id: results.million.id,
    limit: 50,
  });
  if (page.directory.files !== count) throw Error("File count mismatch");
  results.snapshot = {
    directories: page.snapshot.directories,
    resources: page.snapshot.resources,
    cpuMs: page.snapshot.cpuMs,
  };
  const tiny = { ...ref, path: path.join(root, "0") };
  results.legacy = await run("size", tiny);
  results.indexed = await run("storageScan", tiny);
  results.storageLogs = logs.filter((l) => l.stage.startsWith("storage."));
  results.quiet = await core.dispatch("diagnostics");
  await fs.writeFile(
    path.join(output, "storage-profile.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({
      million: results.million,
      worker: results.snapshot,
      legacy: results.legacy,
      indexed: results.indexed,
    }),
  );
} finally {
  await core.dispose();
  await fs.rm(fixture, { recursive: true, force: true });
}
