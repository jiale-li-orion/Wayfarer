import fs from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { connect, sleep } from "./lib/live.mjs";
const output = process.argv[2];
if (!output) throw Error("Output directory required");
await fs.mkdir(output, { recursive: true });
const live = await connect();
if (!/^acceptance-resources \((?:Workspace|工作区)\)/.test(live.session.name))
  throw Error("Use the resource acceptance window");
let page;
async function context() {
  page = await live.canvas();
  return page;
}
async function value(code) {
  return live.evaluate(page, code);
}
async function click(selector, text) {
  await value(
    `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.click()})()`,
  );
}
async function until(test, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await test()) return;
    await sleep(150);
  }
  throw Error("Timed out waiting for resource UI");
}
async function screenshot(name) {
  const r = await live.call(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    live.sid,
  );
  await fs.writeFile(
    path.join(output, name + ".png"),
    Buffer.from(r.data, "base64"),
  );
}
const result = {
  started: new Date().toISOString(),
  session: live.session.id,
  samples: [],
  gpuChecks: [],
  lifecycle: [],
};
if (process.env.WM_RESOURCE_RESUME) {
  Object.assign(
    result,
    JSON.parse(await fs.readFile(path.join(output, "acceptance.json"), "utf8")),
  );
  delete result.error;
}
try {
  await live.command("Workspace Map: 查看机器资源");
  await context();
  await live.normalizeWindow();
  if (!process.env.WM_RESOURCE_RESUME) {
    await until(() =>
      value('document.querySelectorAll(".machine-card").length===4'),
    );
    await until(
      async () =>
        (await live.ipc("systemResources")).snapshots.filter(
          (s) => s.status === "online",
        ).length === 4,
      30000,
    );
    await sleep(1000);
    await screenshot("01-overview");
    for (const endpoint of ["windows-c", "wsl-ubuntu", "train", "infer"]) {
      const data = await live.ipc("systemResources", {
        endpoint,
        section: "gpus",
      });
      assert.equal(data.status, "online");
      const count = data.gpus.length;
      if (endpoint === "windows-c") assert.equal(count, 2);
      if (endpoint === "train") assert.equal(count, 8);
      if (endpoint === "infer") assert.equal(count, 1);
      result.gpuChecks.push({
        endpoint,
        count,
        gpus: data.gpus,
        collector: data.collector,
      });
    }
    await value(
      '[...document.querySelectorAll(".machine-card")].find(e=>e.textContent.includes("训练机")).click()',
    );
    await until(() => value('!!document.querySelector(".resource-tabs")'));
    await click(".resource-tabs button", "GPU");
    await until(() =>
      value('document.querySelectorAll("button.gpu-row").length===8'),
    );
    await value('document.querySelector("button.gpu-row").click()');
    await until(() => value('!!document.querySelector(".resource-drawer dl")'));
    await screenshot("03-gpu-detail");
    await click(".resource-drawer button", "关闭");
    await click(".resource-tabs button", "进程");
    await until(() =>
      value('document.querySelectorAll("button.process-row").length>0'),
    );
    await screenshot("02-machine-processes");
    result.uiBefore = await live.sampleCanvas(page);
    const proc = await live.ipc("systemResources", {
      endpoint: "train",
      section: "processes",
      limit: 50,
      sort: "rss",
    });
    assert.ok(proc.total > 50);
    assert.equal(proc.processes.length, 50);
    const next = await live.ipc("systemResources", {
      endpoint: "train",
      section: "processes",
      limit: 50,
      offset: 50,
      sort: "rss",
    });
    assert.equal(next.offset, 50);
    assert.ok(
      proc.processes.every((p) => !("cmdline" in p) && !("environment" in p)),
    );
    const own =
      proc.processes.find((p) => p.user === "lijiale") ?? proc.processes[0];
    const detail = await live.ipc("systemResources", {
      endpoint: "train",
      section: "process",
      pid: own.pid,
      identity: own.identity,
    });
    assert.ok(detail.detail);
    result.processCheck = {
      total: proc.total,
      page: proc.processes.length,
      nextPage: next.processes.length,
      detailKeys: Object.keys(detail.detail),
    };
    await click(".breadcrumbs button", "机器资源");
    await until(() =>
      value('document.querySelectorAll(".machine-card").length===4'),
    );
    await click(".toolbar-actions button", "开始记录");
    await until(
      async () => !!(await live.ipc("systemResources")).recording?.file,
    );
    const recording = (await live.ipc("systemResources")).recording;
    assert.ok(recording?.file);
    result.recording = recording;
    const seconds = Number(process.env.WM_RESOURCE_SECONDS ?? 600);
    for (let n = 0; n <= Math.ceil(seconds / 10); n++) {
      const state = await live.ipc("systemResources");
      result.samples.push({
        at: Date.now(),
        stats: state.stats,
        snapshots: state.snapshots.map((s) => ({
          endpoint: s.endpoint,
          status: s.status,
          stamp: s.stamp,
          collector: s.collector,
          system: s.system,
          gpus: s.gpus,
        })),
      });
      if (n % 6 === 0)
        console.log("resource samples", n, "/", Math.ceil(seconds / 10));
      if (n < Math.ceil(seconds / 10)) await sleep(10000);
    }
    await click(".toolbar-actions button", "停止记录");
    await until(async () => !(await live.ipc("systemResources")).recording);
  }
  await live.command("File: New Text File");
  await sleep(500);
  await until(async () => {
    const s = await live.ipc("diagnostics");
    return (
      s.monitor.channels === 0 && s.monitor.pending === 0 && !s.monitor.timer
    );
  });
  result.hidden = await live.ipc("diagnostics");
  const mainEval = async (expr) => {
    const r = await live.call(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true },
      live.sid,
    );
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const clickTab = async (resource) => {
    const point = await mainEval(
      `(()=>{const e=[...document.querySelectorAll('.tab')].find(e=>${resource ? "e.textContent.includes('机器资源')" : "/Untitled|未命名/.test(e.textContent)"});if(!e)throw Error('Acceptance tab missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await live.call(
        "Input.dispatchMouseEvent",
        { type, ...point, button: "left", clickCount: 1 },
        live.sid,
      );
  };
  for (let i = 0; i < Number(process.env.WM_RESOURCE_ROUNDS ?? 50); i++) {
    await clickTab(true);
    await context();
    await until(() => value('!!document.querySelector(".resources-root")'));
    await clickTab(false);
    await until(async () => {
      const s = await live.ipc("diagnostics");
      return (
        s.monitor.channels === 0 && s.monitor.pending === 0 && !s.monitor.timer
      );
    });
    result.lifecycle.push((await live.ipc("diagnostics")).monitor);
    if (i % 10 === 0) console.log("lifecycle", i + 1, "/ 50");
  }
  const idleSeconds = Number(process.env.WM_RESOURCE_IDLE_SECONDS ?? 600);
  result.idle = [];
  for (let n = 0; n <= Math.ceil(idleSeconds / 15); n++) {
    const s = await live.ipc("diagnostics");
    assert.equal(s.monitor.channels, 0);
    assert.equal(s.monitor.timer, false);
    result.idle.push({ at: Date.now(), host: s.host, monitor: s.monitor });
    if (n % 4 === 0)
      console.log("idle samples", n, "/", Math.ceil(idleSeconds / 15));
    if (n < Math.ceil(idleSeconds / 15)) await sleep(15000);
  }
  result.completed = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(result, null, 2),
  );
  console.log("Resource acceptance completed");
} catch (error) {
  result.error = String(error);
  await fs.writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(result, null, 2),
  );
  throw error;
} finally {
  live.close();
}
