import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { connect, sleep } from "./lib/live.mjs";
const output = process.argv[2];
if (!output) throw Error("Output directory required");
await fs.mkdir(output, { recursive: true });
const live = await connect();
if (!/^acceptance-resources \((?:Workspace|工作区)\)/.test(live.session.name))
  throw Error("Use isolated acceptance workspace");
const dir = await fs.mkdtemp(
  path.join(os.tmpdir(), "wayfarer-resource-transfer-"),
);
const filename = "payload.bin",
  source = { endpoint: "wsl-ubuntu", path: path.join(dir, filename) };
const data = Buffer.alloc(8 * 1024 * 1024, 0x53);
await fs.writeFile(source.path, data);
const expected = createHash("sha256").update(data).digest("hex");
const remote = "/tmp/" + path.basename(dir),
  peers = ["train", "infer"];
const results = { started: Date.now(), phases: [], cleanup: [] };
try {
  await live.command("File: New Text File");
  for (const phase of ["baseline", "recording"]) {
    if (phase === "recording") {
      await live.ipc("recordingControl", { action: "start" });
      for (let i = 0; i < 50; i++) {
        if ((await live.ipc("systemResources")).recording) break;
        await sleep(100);
      }
      assert.ok((await live.ipc("systemResources")).recording);
      await live.command("File: New Text File");
    }
    const targets = peers.map((endpoint) => ({
      endpoint,
      path: remote + "/" + phase,
    }));
    for (const ref of targets)
      await live.finish(await live.ipc("mkdirPath", { ref }));
    const started = Date.now();
    const jobs = await Promise.all(
      targets.map((target) =>
        live.ipc("transfer", {
          sources: [source],
          target,
          mode: "copy",
          conflict: "overwrite",
        }),
      ),
    );
    let completed = [];
    const browse = [];
    for (let i = 0; i < 300; i++) {
      const at = performance.now();
      const listing = await live.ipc("list", {
        ref: { endpoint: "wsl-ubuntu", path: dir },
        refresh: true,
      });
      assert.ok(listing.entries.some((e) => e.name === filename));
      browse.push(performance.now() - at);
      completed = await Promise.all(
        jobs.map((j) => live.ipc("job", { id: j.id })),
      );
      assert.ok(
        completed.every(
          (j) => !["failed", "cancelled", "paused"].includes(j.state),
        ),
      );
      if (i >= 29 && completed.every((j) => j.state === "completed")) break;
      await sleep(50);
    }
    assert.ok(completed.every((j) => j.state === "completed"));
    for (const target of targets) {
      const hash = createHash("sha256");
      for (let offset = 0; offset < data.length; offset += 1024 * 1024) {
        const encoded = await live.ipc("read", {
          ref: { ...target, path: target.path + "/" + filename },
          offset,
          length: Math.min(1024 * 1024, data.length - offset),
        });
        hash.update(Buffer.from(encoded.data, "base64"));
      }
      assert.equal(hash.digest("hex"), expected);
    }
    browse.sort((a, b) => a - b);
    results.phases.push({
      phase,
      bytesPerPeer: data.length,
      peers: 2,
      jobCompletionMs: Math.max(...completed.map((j) => j.updated)) - started,
      sceneMs: Date.now() - started,
      browseQueries: browse.length,
      browseMedianMs: browse[Math.floor(browse.length * 0.5)],
      browseP95Ms:
        browse[Math.min(browse.length - 1, Math.floor(browse.length * 0.95))],
      hashesMatch: true,
      monitor: (await live.ipc("diagnostics")).monitor,
    });
  }
  await live.ipc("recordingControl", { action: "stop" });
  await sleep(200);
  assert.equal((await live.ipc("systemResources")).recording, undefined);
  results.completed = Date.now();
} catch (error) {
  results.error = String(error);
  throw error;
} finally {
  for (const endpoint of peers) {
    try {
      await live.finish(
        await live.ipc("delete", { refs: [{ endpoint, path: remote }] }),
      );
      results.cleanup.push({ endpoint, removed: true });
    } catch (error) {
      results.cleanup.push({ endpoint, error: String(error) });
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.writeFile(
    path.join(output, "transfer-check.json"),
    JSON.stringify(results, null, 2),
  );
  live.close();
}
console.log(JSON.stringify(results.phases));
