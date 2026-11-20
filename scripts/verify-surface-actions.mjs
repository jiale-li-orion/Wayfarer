import { connect, sleep } from "./lib/live.mjs";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const out = process.argv[2],
  live = await connect();
assert(live.session.name.startsWith("acceptance-surface "));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-project-"));
const endpoint = "wsl-ubuntu",
  ref = { endpoint, path: dir },
  note = { started: Date.now() };
let child, run, page;
const wait = async (check, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(150);
  }
  throw Error("Timed out: " + String(check).slice(0, 130));
};
const read = (e) => live.evaluate(page, e);
const click = (sel) =>
  read("document.querySelector(" + JSON.stringify(sel) + ").click()");
const byText = (sel, text) =>
  read(
    "Array.from(document.querySelectorAll(" +
      JSON.stringify(sel) +
      ")).find(e=>e.textContent.trim()===" +
      JSON.stringify(text) +
      ").click()",
  );
const input = async (sel) => {
  await wait(
    async () =>
      (
        await live.call(
          "Runtime.evaluate",
          {
            expression:
              'document.querySelector(".quick-input-widget input")?.getBoundingClientRect().width>0',
            returnByValue: true,
          },
          live.sid,
        )
      ).result.value,
  );
  if (sel) await live.call("Input.insertText", { text: sel }, live.sid);
  await live.key("Enter", "Enter", 13);
};
try {
  child = spawn("sleep", ["120"], { cwd: dir });
  note.pid = child.pid;
  await live.ipc("registerProject", { ref });
  await live.command("Workspace Map: 显示侧边栏");
  page = await live.canvas();
  await live.ipc("setView", { follow: true, expanded: [] });
  await live.ipc("navigate", {});
  await live.ipc("setView", { follow: false });
  await wait(() =>
    read(
      "!!document.querySelector('[data-machine=\"wsl-ubuntu\"] .machine-metrics button')",
    ),
  );
  await click('[data-machine="wsl-ubuntu"] .machine-metrics button:last-child');
  await wait(() =>
    read('!!document.querySelector(".surface-drawer input[placeholder*=PID]")'),
  );
  await read(
    `(()=>{const el=document.querySelector(".surface-drawer input[placeholder*=PID]");Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(el,"${child.pid}");el.dispatchEvent(new window.Event("input",{bubbles:true}));})()`,
  );
  await wait(() =>
    read(
      `Array.from(document.querySelectorAll("button.process-row")).some(e=>e.innerText.includes("${child.pid}"))`,
    ),
  );
  await read(
    `Array.from(document.querySelectorAll("button.process-row")).find(e=>e.innerText.includes("${child.pid}")).click()`,
  );
  await wait(() =>
    read(
      'Array.from(document.querySelectorAll(".surface-drawer button")).some(b=>b.textContent==="加入作业")',
    ),
  );
  await byText(".surface-drawer button", "加入作业");
  await input("项目归属验收");
  await wait(
    async () =>
      (
        await live.call(
          "Runtime.evaluate",
          {
            expression:
              'document.querySelector(".quick-input-widget")?.innerText.includes("作业所属项目")',
            returnByValue: true,
          },
          live.sid,
        )
      ).result.value,
  );
  await input();
  await wait(async () => {
    run = (await live.ipc("workloadsPage", { observe: false })).items.find(
      (w) => w.process?.pid === child.pid,
    );
    return !!run;
  });
  assert.deepEqual(run.projectRef, ref);
  note.prefill = true;
  await click('[aria-label="关闭地图详情"]');
  await wait(() =>
    read(
      'Array.from(document.querySelectorAll(".project-tile")).some(el=>el.textContent.includes("wf-project-"))',
    ),
  );
  await read(
    'Array.from(document.querySelectorAll(".project-tile")).find(el=>el.textContent.includes("wf-project-")).click()',
  );
  await wait(async () => (await live.ipc("view")).root?.path === dir);
  await wait(() => read('document.querySelectorAll(".run-tile").length===1'));
  note.unique = true;
  await fs.writeFile(path.join(dir, "sample.txt"), "fixture");
  const job = await live.ipc("storageScan", { ref, operationId: dir });
  await live.finish(job);
  await live.ipc("setView", { follow: true });
  await live.ipc("navigate", {});
  await live.ipc("setView", { follow: false });
  await wait(() =>
    read("!!document.querySelector('[data-machine=\"wsl-ubuntu\"] .mount')"),
  );
  await click('[data-machine="wsl-ubuntu"] .mount');
  await wait(() =>
    read(
      'document.querySelector(".surface-drawer h2")?.textContent==="目录占用"',
    ),
  );
  note.diskDrawer = true;
} finally {
  if (run)
    await live.ipc("workloadForget", { runId: run.runId }).catch(() => {});
  child?.kill();
  await live.ipc("registerProject", { ref, remove: true }).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
  await fs.writeFile(
    path.join(out, "project-association.json"),
    JSON.stringify(note, null, 2),
  );
  live.close();
}
