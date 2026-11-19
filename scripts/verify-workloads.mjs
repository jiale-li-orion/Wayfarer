import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { connect, sleep } from "./lib/live.mjs";

const out = process.argv[2];
if (!out) throw Error("An acceptance directory is required");
const live = await connect();
const receipt = { opened: new Date().toISOString(), cycles: 0, idle: [] };
const save = () =>
  fs.writeFile(
    path.join(out, "workloads-lifecycle.json"),
    JSON.stringify(receipt, null, 2),
  );
async function until(check, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(180);
  }
  throw Error("Acceptance condition timed out");
}
const quiet = (s) =>
  !s.readers &&
  !s.comparisonViews &&
  !s.timer &&
  !s.channels &&
  !s.pending &&
  !s.retiringChannels;
async function screenshot(name) {
  const v = await live.call(
    "Page.captureScreenshot",
    { format: "png" },
    live.sid,
  );
  await fs.writeFile(
    path.join(out, name + ".png"),
    Buffer.from(v.data, "base64"),
  );
}
try {
  assert(live.session.name.startsWith("acceptance-workloads "));
  await live.command("Workspace Map: 查看机器资源");
  let page = await live.canvas();
  let read = (expr) => live.evaluate(page, expr);
  await until(
    () =>
      read(
        'document.querySelectorAll(".fleet-table tbody tr").length>=4 && !document.querySelector(".fleet-table").textContent.includes("读取中")',
      ),
    90000,
  );
  receipt.table = await read(
    'Array.from(document.querySelectorAll(".fleet-table tbody tr"),tr=>tr.innerText)',
  );
  await screenshot("machines");
  if (process.env.WM_VERIFY_MODEL) {
    const endpoint = process.env.WM_VERIFY_ENDPOINT;
    await live.ipc("workloadRegister", {
      runId: "cpu-replay",
      endpoint,
      name: "CPU LoRA 回放",
      state: "completed",
      step: 2,
      files: [
        {
          kind: "model",
          endpoint,
          path: process.env.WM_VERIFY_MODEL,
          label: "CPU 对照",
        },
      ],
    });
  }
  // Changing the visible route releases its panel subscriptions independently of the editor.
  for (let i = 0; i < 50; i++) {
    await read(
      'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="作业").click()',
    );
    await until(() =>
      read(
        '!!document.querySelector(".performance-head h1") && document.querySelector(".performance-head h1").textContent==="作业"',
      ),
    );
    if (i === 0) await screenshot("workloads");
    await read(
      'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="机器").click()',
    );
    await until(() => read('!!document.querySelector(".fleet-table")'));
    receipt.cycles++;
  }
  if (process.env.WM_VERIFY_MODEL) {
    await read(
      'Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="作业").click()',
    );
    await until(() => read('!!document.querySelector(".workload-row")'));
    await read('document.querySelector(".workload-row").click()');
    await until(() =>
      read(
        'Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("CPU 对照"))',
      ),
    );
    await read(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("CPU 对照")).click()',
    );
    await until(() =>
      read('!!document.querySelector(".model-timeline button")'),
    );
    receipt.replay = await read(
      'document.querySelector(".model-analysis h2")?.textContent',
    );
  }
  await live.command("File: New Text File");
  await until(
    async () => quiet((await live.ipc("diagnostics")).monitor),
    90000,
  );
  receipt.idleStarted = Date.now();
  await save();
  const end = receipt.idleStarted + 600000;
  do {
    const d = await live.ipc("diagnostics");
    assert(quiet(d.monitor), JSON.stringify(d.monitor));
    receipt.idle.push({ stamp: Date.now(), monitor: d.monitor });
    await save();
    if (Date.now() < end) await sleep(Math.min(30000, end - Date.now()));
  } while (receipt.idle.at(-1).stamp < end);
  receipt.finished = new Date().toISOString();
} catch (e) {
  receipt.error = String(e);
  process.exitCode = 1;
} finally {
  await save();
  live.close();
}
