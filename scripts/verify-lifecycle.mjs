import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect, sleep } from "./lib/live.mjs";
const out = process.argv[2];
if (!out) throw Error("Specify output JSON");
const live = await connect(),
  { ipc, finish } = live;
const config = process.env.WM_SSH_CONFIG;
if (!config) throw Error("Set WM_SSH_CONFIG");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-map-load-"));
const remote = "/tmp/" + path.basename(fixture),
  ref = { endpoint: "wsl-ubuntu", path: fixture };
const results = {
  started: new Date().toISOString(),
  browse: [],
  transfers: [],
  resources: [],
};
const peers = [
  ["load-train", "gpu-lab", "/home/lijiale"],
  ["load-infer", "serve-lab", "/home/jiale"],
];
const resources = async () =>
  Promise.all(
    ["windows-c", "wsl-ubuntu", ...peers.map((p) => p[0])].map(
      async (endpoint) => ({
        endpoint,
        ...(await ipc("resources", { endpoint })),
      }),
    ),
  );
let canvas;
async function navigate(p) {
  const start = performance.now();
  await ipc("setView", { follow: true });
  await ipc("navigate", { ref: { ...ref, path: p } });
  const name = path.basename(p);
  for (let n = 0; n < 100; n++) {
    if (
      await live.evaluate(
        canvas,
        `[...document.querySelectorAll('.node-label strong')].some(e=>e.textContent===${JSON.stringify(name)})`,
      )
    )
      return performance.now() - start;
    await sleep(20);
  }
  throw Error("Navigation did not paint " + name);
}
try {
  await live.command("Workspace Map: 打开目录地图");
  canvas = await live.canvas();
  for (const [id, host, root] of peers) {
    await ipc("addEndpoint", {
      id,
      kind: "ssh",
      name: id,
      host,
      root,
      sshConfig: config,
      distro: "Ubuntu",
      python: "python3",
    });
    await finish(
      await ipc("mkdirPath", { ref: { endpoint: id, path: remote } }),
    );
  }
  for (const r of [
    { endpoint: "windows-c", path: "C:\\Users\\29461" },
    { endpoint: "wsl-ubuntu", path: "/home/orion" },
    ...peers.map(([endpoint, , path]) => ({ endpoint, path })),
  ]) {
    const start = performance.now(),
      page = await ipc("list", { ref: r, refresh: true });
    assert.equal(page.error, undefined);
    results.browse.push({
      kind: "real-root",
      endpoint: r.endpoint,
      count: page.entries.length,
      ms: performance.now() - start,
    });
  }
  for (let g = 0; g < 5; g++) {
    const dir = path.join(fixture, "group-" + g);
    await fs.mkdir(dir);
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        fs.writeFile(path.join(dir, "文件 " + i + ".txt"), "fixture"),
      ),
    );
  }
  for (let i = 0; i < 160; i++)
    await fs.mkdir(path.join(fixture, "empty-" + i));
  await navigate(fixture);
  await ipc("setView", {
    expanded: Array.from({ length: 5 }, (_, i) =>
      JSON.stringify([ref.endpoint, path.join(fixture, "group-" + i)]),
    ),
    follow: true,
  });
  await ipc("navigate", { ref });
  await sleep(1000);
  results.loaded = await live.sampleCanvas(canvas);
  for (let round = 0; round < 8; round++) {
    const before = await live.sampleCanvas(canvas),
      latency = [];
    for (let n = 0; n < 20; n++)
      latency.push(
        await navigate(path.join(fixture, "empty-" + (round * 20 + n))),
      );
    await live.call("HeapProfiler.collectGarbage", {}, canvas.session);
    results.browse.push({
      kind: "20-navigation-cycle",
      round,
      latency,
      before,
      after: await live.sampleCanvas(canvas),
      diagnostics: await ipc("diagnostics").catch(() => null),
    });
  }
  await navigate(fixture);
  // Actual pointer input exits Agent follow mode.
  await ipc("setView", { follow: true });
  await live.call(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: 600, y: 400, button: "left", clickCount: 1 },
    canvas.session,
  );
  await live.call(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: 600, y: 400, button: "left", clickCount: 1 },
    canvas.session,
  );
  await sleep(100);
  assert.equal((await ipc("view")).follow, false);
  results.manualOverride = true;
  const block = Buffer.alloc(1048576, 57),
    digest = createHash("sha256");
  for (let n = 0; n < 64; n++) digest.update(block);
  const expected = digest.digest("hex");
  for (const name of ["one.bin", "two.bin"]) {
    const f = await fs.open(path.join(fixture, name), "w");
    for (let n = 0; n < 64; n++) await f.write(block);
    await f.close();
  }
  results.resources.push({
    phase: "before-transfer",
    values: await resources(),
  });
  const start = performance.now();
  const jobs = await Promise.all(
    peers.map(([endpoint], i) =>
      ipc("transfer", {
        sources: [
          { ...ref, path: path.join(fixture, i ? "two.bin" : "one.bin") },
        ],
        target: { endpoint, path: remote },
        mode: "copy",
        conflict: "overwrite",
      }),
    ),
  );
  const framesPending = live.evaluate(
    canvas,
    `new Promise(resolve=>{const pane=document.querySelector('.react-flow__pane'),d=[];let n=0,last=performance.now();function frame(now){d.push(now-last);last=now;pane.dispatchEvent(new WheelEvent('wheel',{deltaY:n%2?5:-5,clientX:400,clientY:300,bubbles:true,cancelable:true}));if(++n<120)requestAnimationFrame(frame);else{const sorted=[...d].sort((a,b)=>a-b);resolve({count:n,meanMs:d.reduce((a,b)=>a+b,0)/n,p95Ms:sorted[Math.floor(n*.95)],maxMs:sorted.at(-1)})}}requestAnimationFrame(frame)})`,
    true,
  );
  const reads = [],
    states = [];
  let maxRunning = 0;
  while (true) {
    const current = await Promise.all(
      jobs.map((j) => ipc("job", { id: j.id })),
    );
    maxRunning = Math.max(
      maxRunning,
      current.filter((j) => j.state === "running").length,
    );
    if (
      current.some((j) => ["failed", "cancelled", "paused"].includes(j.state))
    )
      throw Error(JSON.stringify(current));
    if (current.every((j) => j.state === "completed")) {
      states.push(...current.map((j) => ({ state: j.state, bytes: j.bytes })));
      break;
    }
    const t = performance.now();
    await ipc("list", { ref, refresh: true });
    reads.push(performance.now() - t);
    results.resources.push({ phase: "transfer", values: await resources() });
    await sleep(100);
  }
  for (let i = 0; i < peers.length; i++) {
    const [id, host] = peers[i];
    const { stdout } = await promisify(execFile)("ssh", [
      "-F",
      config,
      host,
      "sha256sum " + remote + "/" + (i ? "two.bin" : "one.bin"),
    ]);
    assert.equal(stdout.split(/\s/)[0], expected);
  }
  results.transfers.push({
    kind: "parallel-64MiB",
    frames: await framesPending,
    ms: performance.now() - start,
    maxRunning,
    browseMs: reads,
    states,
    sha256: expected,
  });
  const t = performance.now();
  const small = await finish(
    await ipc("transfer", {
      sources: [{ ...ref, path: path.join(fixture, "group-0") }],
      target: { endpoint: "load-train", path: remote },
      mode: "copy",
      conflict: "overwrite",
    }),
  );
  results.transfers.push({
    kind: "small-files",
    ms: performance.now() - t,
    files: small.files,
    bytes: small.bytes,
    state: small.state,
  });
  const cancelled = await ipc("transfer", {
    sources: [{ ...ref, path: path.join(fixture, "one.bin") }],
    target: { endpoint: "load-train", path: remote },
    mode: "copy",
    conflict: "rename",
  });
  for (let n = 0; n < 200; n++) {
    const j = await ipc("job", { id: cancelled.id });
    if (j.bytes > 0) break;
    await sleep(20);
  }
  await ipc("jobControl", { id: cancelled.id, action: "cancel" });
  for (let n = 0; n < 200; n++) {
    const j = await ipc("job", { id: cancelled.id });
    if (j.state === "cancelled") {
      results.cancel = {
        state: j.state,
        sourcePresent: !!(await fs.stat(path.join(fixture, "one.bin"))),
      };
      break;
    }
    await sleep(20);
  }
  assert.equal(results.cancel?.state, "cancelled");
  results.resources.push({
    phase: "after-transfer",
    values: await resources(),
  });
  await ipc("setView", { expanded: [], follow: true });
  await ipc("navigate", {});
  await sleep(300);
  results.collapsed = await ipc("diagnostics").catch(() => null);
  await live.command("File: New Text File");
  await sleep(1000);
  results.hidden = await ipc("diagnostics").catch(() => null);
  if (results.hidden) assert.equal(results.hidden.directories.watches, 0);
  await live.command("Workspace Map: 打开目录地图");
  await sleep(500);
  const closeTab = await live.call(
    "Runtime.evaluate",
    {
      expression: `(()=>{const tab=[...document.querySelectorAll('.tab')].find(e=>e.textContent==='Workspace Map');const close=tab?.querySelector('.tab-actions [aria-label^="Close"]');if(!close)throw Error('Map tab close affordance absent');close.click()})()`,
    },
    live.sid,
  );
  if (closeTab.exceptionDetails) throw Error(closeTab.exceptionDetails.text);
  await sleep(500);
  results.closed = await ipc("diagnostics").catch(() => null);
  if (results.closed) assert.equal(results.closed.directories.watches, 0);
} finally {
  for (const [endpoint] of peers) {
    try {
      await finish(await ipc("delete", { refs: [{ endpoint, path: remote }] }));
      const before = await ipc("resources", { endpoint });
      await ipc("endpointControl", { endpoint, action: "disconnect" });
      results.resources.push({
        phase: "disconnect",
        endpoint,
        pid: before.pid,
      });
    } catch (e) {
      results.cleanupError = String(e);
    }
  }
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(results, null, 2));
  live.close();
  console.log(out);
}
