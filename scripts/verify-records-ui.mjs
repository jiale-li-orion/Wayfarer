import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { connect, sleep } from "./lib/live.mjs";
const out = process.argv[2],
  live = await connect(),
  result = { cycles: 0, idle: [] };
assert(live.session.name.startsWith("acceptance-records "));
const runName = process.env.WM_VERIFY_NAME ?? "离线 CPU 回放";
const save = () =>
  fs.writeFile(
    path.join(out, "records-ui.json"),
    JSON.stringify(result, null, 2),
  );
const wait = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await sleep(160);
  }
  throw Error("UI timeout: " + String(fn));
};
const quiet = (d) =>
  !d.monitor.readers &&
  !d.monitor.comparisonViews &&
  !d.monitor.pending &&
  !d.monitor.channels &&
  !d.monitor.timer &&
  !d.monitor.retiringChannels &&
  d.projectRuns?.inflight === 0 &&
  d.projectRuns?.cursors === 0;
let page;
const read = (s) => live.evaluate(page, s);
const clickFit = async () => {
  await read(
    'document.querySelector(".react-flow__controls-fitview")?.click()',
  );
  await sleep(450);
};
const open = async () => {
  await live.command("Workspace Map: 打开目录地图");
  page = await live.canvas();
};
try {
  await open();
  await live.ipc("setView", { follow: true });
  await live.ipc("navigate", {});
  await live.ipc("setView", { follow: false });
  await wait(() => read('document.querySelectorAll(".wf-machine").length===5'));
  const projects = await live.ipc("projects");
  const project = projects.find(
    (p) => p.endpoint === process.env.WM_VERIFY_ENDPOINT,
  );
  assert(project);
  await live.ipc("setView", { follow: true });
  await live.ipc("navigate", { ref: project });
  await live.ipc("setView", { follow: false });
  await wait(() =>
    read('document.querySelector(".status")?.textContent.includes("节点")'),
  );
  await clickFit();
  await wait(() =>
    read(
      `Array.from(document.querySelectorAll(".run-tile")).some(e=>e.textContent.includes(${JSON.stringify(runName)}))`,
    ),
  );
  result.offlineVisible = true;
  await live.ipc("setView", { follow: true });
  await live.ipc("navigate", {});
  await live.ipc("setView", { follow: false });
  await sleep(900);
  await clickFit();
  await wait(() => read('document.querySelectorAll(".wf-machine").length===5'));
  result.wsl = await read(
    "document.querySelector('[data-machine=\"wsl-ubuntu\"]').innerText",
  );
  assert(result.wsl.includes("10") && result.wsl.includes("核"));
  await read('document.querySelector(".surface-menu summary").click()');
  result.menu = await read('document.querySelector(".surface-menu").innerText');
  assert(!/导出|打开模型记录|打开耗时记录/.test(result.menu));
  await read('document.querySelector(".surface-menu summary").click()');
  for (const [index, sort] of [
    [0, "cpuPercent"],
    [1, "rss"],
  ]) {
    await read(
      `document.querySelectorAll('[data-machine="wsl-ubuntu"] .machine-metrics button')[${index}].click()`,
    );
    await wait(() =>
      read(
        '!!document.querySelector(".surface-drawer select[aria-label=进程排序]")',
      ),
    );
    assert.equal(
      await read(
        'document.querySelector(".surface-drawer select[aria-label=进程排序]").value',
      ),
      sort,
    );
    await read('document.querySelector("[aria-label=关闭地图详情]").click()');
  }
  result.sorting = true;
  await read(
    'Array.from(document.querySelectorAll(".wf-machine")).find(m=>m.innerText.includes("训练机2")).querySelector(".mount").click()',
  );
  await wait(() =>
    read(
      'Array.from(document.querySelectorAll(".surface-drawer option")).some(o=>o.value==="/data")',
    ),
  );
  await read(
    '(()=>{const s=document.querySelector(".surface-drawer select");s.value="/data";s.dispatchEvent(new window.Event("change",{bubbles:true}));})()',
  );
  await read(
    'Array.from(document.querySelectorAll(".surface-drawer button")).find(b=>b.textContent==="在机器卡显示").click()',
  );
  await wait(() =>
    read(
      'Array.from(document.querySelectorAll(".wf-machine")).find(m=>m.innerText.includes("训练机2")).querySelector(".mount").innerText.includes("/data")',
    ),
  );
  result.pin = "/data";
  await read('document.querySelector("[aria-label=关闭地图详情]").click()');
  const pic = await live.call(
    "Page.captureScreenshot",
    { format: "png" },
    live.sid,
  );
  await fs.writeFile(
    path.join(out, "map.png"),
    Buffer.from(pic.data, "base64"),
  );
  for (let i = 0; i < 50; i++) {
    await live.command("View: Close Editor");
    await wait(async () => quiet(await live.ipc("diagnostics")));
    await open();
    await wait(() => read('!!document.querySelector(".wf-machine")'));
    result.cycles++;
  }
  await live.command("File: New Text File");
  await wait(async () => quiet(await live.ipc("diagnostics")));
  result.idleStarted = Date.now();
  await save();
  do {
    const d = await live.ipc("diagnostics");
    assert(quiet(d));
    result.idle.push({
      stamp: Date.now(),
      monitor: d.monitor,
      projectRuns: d.projectRuns,
    });
    await save();
    const left = result.idleStarted + 600000 - Date.now();
    if (left > 0) await sleep(Math.min(30000, left));
  } while (result.idle.at(-1).stamp < result.idleStarted + 600000);
  assert.equal(
    result.idle[0].projectRuns.pagesRead,
    result.idle.at(-1).projectRuns.pagesRead,
  );
  result.finished = Date.now();
} catch (e) {
  result.error = String(e);
  process.exitCode = 1;
} finally {
  await save();
  live.close();
}
