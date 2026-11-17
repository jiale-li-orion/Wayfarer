import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
async function main() {
  const config = process.env.WM_SSH_CONFIG,
    helper = process.env.WM_HELPER_PATH;
  if (!config || !helper) throw Error("Set WM_SSH_CONFIG and WM_HELPER_PATH");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-map-transport-"),
  );
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  const remote = "/tmp/" + path.basename(root),
    events: any[] = [],
    samples: any[] = [];
  const core = new Core(
    path.join(root, "state"),
    helper,
    new Profiler((line) => {
      const e = JSON.parse(line);
      if (e.stage.startsWith("job.")) events.push(e);
    }),
  );
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await core.init([
    { id: "source", kind: "local", root: source, name: "Source" },
    { id: "target", kind: "local", root: target, name: "Target" },
    {
      id: "remote",
      kind: "ssh",
      name: "Train",
      host: "gpu-lab",
      sshConfig: config,
      root: remote,
      python: "python3",
    },
  ]);
  const endpoint = core.endpoints.get("remote");
  const file = path.join(source, "payload.bin"),
    h = await fs.open(file, "w");
  const block = Buffer.alloc(1048576, 71);
  for (let n = 0; n < 64; n++) await h.write(block);
  await h.close();
  try {
    await endpoint.call("mkdir", { path: remote });
    for (const direction of ["upload", "download"]) {
      const before = await endpoint.call("resources"),
        cpu = process.cpuUsage(),
        mem = process.memoryUsage(),
        start = performance.now();
      let peak = mem.rss;
      let peakHelperRss = before.rss,
        transferHelperPid: number | undefined;
      let sampling: Promise<void> | undefined;
      const sampleTimer = process.env.WM_SAMPLE_HELPERS
        ? setInterval(() => {
            if (sampling) return;
            sampling = endpoint
              .call("resources")
              .then((r) => {
                peakHelperRss = Math.max(
                  peakHelperRss,
                  r.rss + (r.transfer?.rss ?? 0),
                );
                transferHelperPid ??= r.transfer?.pid;
              })
              .finally(() => {
                sampling = undefined;
              });
          }, 500)
        : undefined;
      const browse: number[] = [];
      const job = await core.dispatch("transfer", {
        sources: [
          direction === "upload"
            ? { endpoint: "source", path: file }
            : { endpoint: "remote", path: remote + "/payload.bin" },
        ],
        target:
          direction === "upload"
            ? { endpoint: "remote", path: remote }
            : { endpoint: "target", path: target },
        mode: "copy",
        conflict: "overwrite",
      });
      while (["queued", "running"].includes(core.jobs.get(job.id).state)) {
        const t = performance.now();
        const page = await core.directories.list(
          { endpoint: "remote", path: remote },
          undefined,
          true,
          "agent",
        );
        if (page.cursor)
          await endpoint.call("scanClose", { cursor: page.cursor });
        browse.push(performance.now() - t);
        peak = Math.max(peak, process.memoryUsage().rss);
        await sleep(50);
      }
      clearInterval(sampleTimer);
      await sampling;
      const done = await core.dispatch("job", { id: job.id });
      if (done.state !== "completed") throw Error(done.error);
      const delta = process.cpuUsage(cpu),
        after = await endpoint.call("resources");
      samples.push({
        direction,
        wallMs: performance.now() - start,
        cpuMs: (delta.user + delta.system) / 1000,
        rssStart: mem.rss,
        peakRss: peak,
        peakHelperRss,
        transferHelperPid,
        browseMs: browse,
        before,
        after,
        bytes: done.bytes,
      });
    }
    const [a, b] = await Promise.all([
      core.endpoints.get("source").call("hash", { path: file }),
      core.endpoints
        .get("target")
        .call("hash", { path: path.join(target, "payload.bin") }),
    ]);
    if (a !== b) throw Error("roundtrip hash mismatch");
    await fs.writeFile(
      process.argv[2],
      JSON.stringify(
        {
          environment: { platform: process.platform, node: process.version },
          samples,
          sha256: a,
          events,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        samples.map((s) => ({
          direction: s.direction,
          ms: s.wallMs,
          cpuMs: s.cpuMs,
          MiBps: s.bytes / 1048576 / (s.wallMs / 1000),
          transport: s.after.transport,
        })),
      ),
    );
  } finally {
    await endpoint
      .call("remove", { path: remote, recursive: true })
      .catch(() => {});
    await core.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main();
