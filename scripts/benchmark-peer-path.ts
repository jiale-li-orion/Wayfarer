import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
import type { EndpointConfig } from "../src/shared/types";
const [manifest, helper, output] = process.argv.slice(2);
const config = JSON.parse(await fs.readFile(manifest, "utf8"));
const rows: any[] = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const staged = await fs.mkdtemp(path.join(os.tmpdir(), "wayfarer-peer-bench-"));
try {
  for (const [index, scenario] of config.scenarios.entries()) {
    const logs: any[] = [];
    const core = new Core(
      path.join(staged, String(index)),
      helper,
      new Profiler((value) => {
        if (logs.length < 120) logs.push(value);
      }),
    );
    const warm: { release(): void }[] = [];
    await core.init(config.endpoints as EndpointConfig[]);
    try {
      if (scenario.pair)
        await core.dispatch("peerPairSave", { pair: scenario.pair });
      const [source, target] = config.endpoints.map((e: EndpointConfig) =>
        core.endpoints.get(e.id),
      );
      if (scenario.warm)
        for (const e of [source, target]) {
          const lease = e.openTransfer?.();
          if (lease) {
            warm.push(lease);
            await lease.endpoint.call("info");
          }
        }
      const directoryLatencyMs: number[] = [];
      const directoryErrors: string[] = [];
      const directoryQuery = () => source.call("list", {
        path: path.posix.join(config.source, "small"), limit: 10,
      });
      if (scenario.directory) await directoryQuery();
      const cpu = process.cpuUsage();
      const before = process.memoryUsage().rss;
      const start = performance.now();
      const job = await core.dispatch("transfer", {
        sources: [
          {
            endpoint: source.config.id,
            path: path.posix.join(config.source, scenario.input),
          },
        ],
        target: {
          endpoint: target.config.id,
          path: path.posix.join(config.target, "run-" + index),
        },
        mode: scenario.mode ?? "copy",
        conflict: scenario.conflict ?? "skip",
        ...(scenario.transport ? { transport: scenario.transport } : {}),
      });
      let issuedCancel = false;
      let observed = core.jobs.get(job.id);
      let interruptedAt = 0;
      let pausedAt: number | undefined;
      let peakRss = before;
      let sampling: Promise<unknown> | undefined;
      let nextDirectory = start;
      while (["queued", "running"].includes(observed.state) ||
             observed.state === "paused" && observed.pauseReason === "network") {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (scenario.directory && !sampling && directoryLatencyMs.length < 12 &&
            performance.now() >= nextDirectory) {
          const directoryStart = performance.now();
          nextDirectory = directoryStart + 550;
          sampling = directoryQuery().then(() => {
            directoryLatencyMs.push(performance.now() - directoryStart);
          }).catch((error: unknown) => { directoryErrors.push(String(error)); }).finally(() => { sampling = undefined; });
        }
        if (observed.state === "paused") pausedAt ??= observed.bytes;
        if (scenario.fault && !interruptedAt && observed.state === "running" &&
            core.peer.stats().channels > 0 && observed.bytes >= 16 * 1048576) {
          interruptedAt = observed.bytes;
          if (scenario.fault === "network") core.peer.abort();
          if (scenario.fault === "cancel") {
            issuedCancel = true;
            await core.dispatch("jobControl", { id: job.id, action: "cancel" });
          }
          if (scenario.fault === "source-change")
            await source.call("metadata", {
              path: path.posix.join(config.source, scenario.input),
              mode: 0o600, mtime: Date.now(),
            });
        }
        if (!issuedCancel && performance.now() - start >= scenario.timeout) {
          issuedCancel = true;
          await core.dispatch("jobControl", { id: job.id, action: "cancel" });
        }
        await delay(50);
        observed = core.jobs.get(job.id);
      }
      const elapsedAtExit = performance.now() - start;
      await sampling;
      let result = await core.dispatch("job", { id: job.id });
      for (let attempt = 0; result.state !== observed.state && attempt < 60; attempt++) {
        await delay(50);
        result = await core.dispatch("job", { id: job.id });
      }
      const elapsedMs = elapsedAtExit;
      const delta = process.cpuUsage(cpu);
      const row = {
        scenario: scenario.name,
        input: scenario.input,
        warm: !!scenario.warm,
        elapsedMs,
        issuedCancel,
        interruptedAt,
        pausedAt,
        directoryLatencyMs,
        directoryErrors,
        channelsAfter: core.peer?.stats().channels ?? 0,
        state: result.state,
        bytes: result.bytes,
        files: result.files,
        result: result.result,
        error: result.error,
        cpuMs: (delta.system + delta.user) / 1000,
        rssBefore: before,
        peakRss,
        rssAfter: process.memoryUsage().rss,
        logs,
      };
      rows.push(row);
      await fs.writeFile(output, JSON.stringify(rows, null, 2) + "\n");
      console.log(
        JSON.stringify({
          ...row,
          result: result.result
            ? { ...result.result, timing: undefined }
            : undefined,
          logs: undefined,
        }),
      );
    } finally {
      warm.reverse().forEach((l) => l.release());
      await core.dispose();
    }
  }
} finally {
  await fs.rm(staged, { recursive: true, force: true });
}
