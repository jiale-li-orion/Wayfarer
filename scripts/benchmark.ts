import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
import { stratify, tree } from "d3-hierarchy";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-map-bench-"));
const a = path.join(dir, "source"),
  b = path.join(dir, "target");
await fs.mkdir(a);
await fs.mkdir(b);
const metrics: any[] = [];
const core = new Core(
  path.join(dir, "state"),
  path.resolve("helpers/endpoint.py"),
  new Profiler((s) => {
    const v = JSON.parse(s);
    if (v.stage !== "job.output") metrics.push(v);
  }),
);
await core.init([
  { id: "a", kind: "local", root: a, name: "Source" },
  { id: "b", kind: "local", root: b, name: "Target" },
]);
core.directories.watch([]);
const samples: any[] = [];
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);
async function measure(name: string, run: () => Promise<any>) {
  const cpu = process.cpuUsage(),
    mem = process.memoryUsage(),
    time = performance.now();
  peakRss = mem.rss;
  const result = await run();
  const delta = process.cpuUsage(cpu);
  samples.push({
    name,
    wallMs: performance.now() - time,
    cpuUserMs: delta.user / 1000,
    cpuSystemMs: delta.system / 1000,
    rssStart: mem.rss,
    rssEnd: process.memoryUsage().rss,
    peakRss,
    heapStart: mem.heapUsed,
    heapEnd: process.memoryUsage().heapUsed,
    result,
  });
}
try {
  await measure(
    "idle_2_seconds",
    () => new Promise((r) => setTimeout(r, 2000)),
  );
  for (let i = 0; i < 2000; i++)
    await fs.writeFile(path.join(a, "目录数据 " + i + ".txt"), "workspace");
  await measure("first_directory_page_200", async () => {
    const p = await core.dispatch("list", {
      ref: { endpoint: "a", path: a },
      refresh: true,
    });
    return { entries: p.entries.length };
  });
  await measure("directory_2000_paged", async () => {
    let cursor;
    let n = 0;
    do {
      const p = await core.dispatch("list", {
        ref: { endpoint: "a", path: a },
        cursor,
        refresh: true,
      });
      n += p.entries.length;
      cursor = p.cursor;
    } while (cursor);
    return { entries: n };
  });
  await measure("d3_1000_nodes_20_layouts", async () => {
    for (let j = 0; j < 20; j++) {
      const items = Array.from({ length: 1000 }, (_, i) => ({
        id: String(i),
        parent: i ? String(Math.floor((i - 1) / 10)) : undefined,
      }));
      tree().nodeSize([66, 310])(
        stratify<any>()
          .id((d) => d.id)
          .parentId((d) => d.parent)(items),
      );
    }
    return { nodes: 1000, layouts: 20 };
  });
  const big = path.join(a, "payload.bin");
  const fh = await fs.open(big, "w");
  for (let i = 0; i < 64; i++) await fh.write(Buffer.alloc(1048576, 42));
  await fh.close();
  await measure("verified_copy_64_MiB", async () => {
    const j = await core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: big }],
      target: { endpoint: "b", path: b },
      mode: "copy",
      conflict: "rename",
    });
    for (;;) {
      const v = core.jobs.get(j.id);
      if (["completed", "failed"].includes(v.state)) {
        if (v.state === "failed") throw Error(v.error);
        return { bytes: v.bytes };
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  await measure(
    "idle_after_transfer_2_seconds",
    () => new Promise((r) => setTimeout(r, 2000)),
  );
  await fs.mkdir("artifacts", { recursive: true });
  await fs.writeFile(
    "artifacts/profile-core.json",
    JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: process.platform,
          cpus: os.cpus().length,
        },
        samples,
        metrics,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(samples, null, 2));
} finally {
  clearInterval(sampler);
  await core.dispose();
  await fs.rm(dir, { recursive: true, force: true });
}
