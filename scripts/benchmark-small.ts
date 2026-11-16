import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-small-"));
  const src = path.join(dir, "source"),
    dst = path.join(dir, "target");
  await fs.mkdir(src);
  await fs.mkdir(dst);
  for (let i = 0; i < 600; i++)
    await fs.writeFile(path.join(src, "file-" + i + ".txt"), "x".repeat(128));
  const core = new Core(
    path.join(dir, "state"),
    path.resolve("helpers/endpoint.py"),
    new Profiler(() => {}),
  );
  await core.init([
    { id: "a", kind: "local", name: "A", root: src },
    { id: "b", kind: "local", name: "B", root: dst },
  ]);
  const start = performance.now(),
    cpu = process.cpuUsage(),
    rss = process.memoryUsage().rss;
  let peak = rss;
  const sampler = setInterval(
    () => (peak = Math.max(peak, process.memoryUsage().rss)),
    10,
  );
  try {
    const j = await core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: src }],
      target: { endpoint: "b", path: dst },
      mode: "copy",
      conflict: "rename",
    });
    for (;;) {
      const state = core.jobs.get(j.id);
      if (state.state === "completed") break;
      if (state.state === "failed") throw Error(state.error);
      await new Promise((r) => setTimeout(r, 20));
    }
    const used = process.cpuUsage(cpu);
    const result = {
      files: 600,
      bytes: 600 * 128,
      wallMs: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
      rssStart: rss,
      rssEnd: process.memoryUsage().rss,
      peakRss: peak,
    };
    await fs.mkdir("artifacts", { recursive: true });
    await fs.writeFile(
      process.argv[2] ?? "artifacts/profile-small.json",
      JSON.stringify(result, null, 2),
    );
    console.log(result);
  } finally {
    clearInterval(sampler);
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
void main();
