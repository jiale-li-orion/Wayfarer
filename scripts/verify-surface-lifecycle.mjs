import { connect, sleep } from "./lib/live.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const out = process.argv[2],
  live = await connect(),
  endpoint = process.env.WM_VERIFY_ENDPOINT,
  model = process.env.WM_VERIFY_MODEL;
assert(
  live.session.name.startsWith("acceptance-surface ") && endpoint && model,
);
const result = { started: Date.now(), cycles: 0, idle: [] },
  runId = "surface-qa-live",
  closedId = "surface-qa-closed";
const save = () =>
  fs.writeFile(
    path.join(out, "map-acceptance.json"),
    JSON.stringify(result, null, 2),
  );
const wait = async (fn, ms = 40000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(140);
  }
  throw Error("Condition timed out: " + String(fn).slice(0, 180));
};
const quiet = (s) =>
  !s.readers &&
  !s.comparisonViews &&
  !s.timer &&
  !s.channels &&
  !s.pending &&
  !s.retiringChannels;
let page;
const read = (e) => live.evaluate(page, e);
const open = async () => {
  await live.command("Workspace Map: 打开目录地图");
  page = await live.canvas();
};
const click = (selector) =>
  read("document.querySelector(" + JSON.stringify(selector) + ").click()");
const shot = async (name) => {
  const v = await live.call(
    "Page.captureScreenshot",
    { format: "png" },
    live.sid,
  );
  await fs.writeFile(
    path.join(out, name + ".png"),
    Buffer.from(v.data, "base64"),
  );
};
try {
  await live.ipc("workloadRegister", {
    runId,
    endpoint,
    projectRef: {
      endpoint,
      path: path.posix.dirname(path.posix.dirname(model)),
    },
    name: "CPU LoRA 回放",
    step: 2,
    phase: "接口验收",
    files: [{ kind: "model", endpoint, path: model }],
  });
  await live.ipc("workloadRegister", {
    runId: closedId,
    endpoint,
    name: "归档验收",
    state: "completed",
  });
  await open();
  await live.ipc("setView", { follow: true, expanded: [] });
  await live.ipc("navigate", {});
  await live.ipc("setView", { follow: false });
  await wait(() =>
    read(
      'document.querySelectorAll(".wf-machine").length===5 && !!document.querySelector(".run-tile")',
    ),
  );
  result.nodes = await read(
    'document.querySelector(".status span").textContent',
  );
  await shot("directory-map");
  await click(".run-tile button:last-child");
  await wait(() =>
    read(
      'document.querySelector(".surface-drawer")?.innerText.includes("取消关注")',
    ),
  );
  await click('button[aria-label="关闭地图详情"]');
  await click(".run-tile button:first-child");
  await wait(
    async () => (await live.ipc("modelAnalysis"))?.ref?.path === model,
  );
  result.directModel = true;
  await live.command("View: Close Editor");
  await open();
  await wait(() => read('!!document.querySelector(".archive-tile")'));
  await click(".archive-tile");
  await wait(() =>
    read(
      'Array.from(document.querySelectorAll(".run-tile")).some(r=>r.textContent.includes("归档验收"))',
    ),
  );
  assert(
    await read(
      'Array.from(document.querySelectorAll(".run-tile,.archive-tile,.wf-machine")).every(n=>!n.querySelector("[draggable=true]"))',
    ),
  );
  await click(".device-grid button:first-child");
  await wait(() =>
    read('!!document.querySelector(".surface-drawer .machine-inspector")'),
  );
  await shot("device-detail");
  await click('button[aria-label="关闭地图详情"]');
  await read(
    'Array.from(document.querySelectorAll(".pair-action")).find(b=>b.getAttribute("aria-label").includes("训练机1")).click()',
  );
  await read(
    'Array.from(document.querySelectorAll(".pair-action")).find(b=>b.getAttribute("aria-label").includes("训练机2")).click()',
  );
  await wait(() =>
    read(
      'document.querySelector(".surface-drawer")?.innerText.includes("链路诊断")',
    ),
  );
  result.pair = true;
  await click('button[aria-label="关闭地图详情"]');
  const owner = JSON.parse(await fs.readFile("owner.json", "utf8"));
  const resize = (w, h) =>
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p=Get-Process -Id " +
        Number(owner.pid) +
        ";if($p.StartTime.ToUniversalTime().ToString('o') -ne '" +
        owner.start +
        "'){throw 'wrong acceptance window'};" +
        'Add-Type -Namespace W -Name Win -MemberDefinition "[DllImport(\`"user32.dll\`")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hgt,uint flags);[DllImport(\`"user32.dll\`")] public static extern bool ShowWindowAsync(IntPtr h,int cmd);";' +
        "[void][W.Win]::ShowWindowAsync($p.MainWindowHandle,9);[void][W.Win]::SetWindowPos($p.MainWindowHandle,[IntPtr]::Zero,0,0," +
        w +
        "," +
        h +
        ",6)",
    ]);
  const old = await live.call(
    "Runtime.evaluate",
    {
      expression: "[window.outerWidth,window.outerHeight]",
      returnByValue: true,
    },
    live.sid,
  );
  try {
    resize(820, 720);
    await sleep(600);
    result.narrow = await read("window.innerWidth");
    await shot("narrow");
  } finally {
    resize(...old.result.value);
  }
  for (let i = 0; i < 50; i++) {
    await live.command("View: Close Editor");
    await wait(async () => quiet((await live.ipc("diagnostics")).monitor));
    await open();
    await wait(() => read('!!document.querySelector(".wf-machine")'));
    result.cycles++;
  }
  await live.command("File: New Text File");
  await wait(async () => quiet((await live.ipc("diagnostics")).monitor));
  result.idleStarted = Date.now();
  const end = result.idleStarted + 600000;
  do {
    const d = await live.ipc("diagnostics");
    assert(quiet(d.monitor), JSON.stringify(d.monitor));
    result.idle.push({ stamp: Date.now(), monitor: d.monitor });
    await save();
    if (Date.now() < end) await sleep(Math.min(30000, end - Date.now()));
  } while (result.idle.at(-1).stamp < end);
  result.finished = Date.now();
} catch (e) {
  result.error = String(e);
  process.exitCode = 1;
} finally {
  await save();
  await live.ipc("workloadForget", { runId }).catch(() => {});
  await live.ipc("workloadForget", { runId: closedId }).catch(() => {});
  live.close();
}
