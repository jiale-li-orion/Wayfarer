import fs from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { connect, sleep } from "./lib/live.mjs";
const output = process.argv[2];
if (!output) throw Error("Output directory required");
const root = Number(process.env.WM_ROOT_PID);
if (!Number.isSafeInteger(root) || root <= 0)
  throw Error("Set isolated WM_ROOT_PID");
const live = await connect();
if (!/^acceptance-resources \((?:Workspace|工作区)\)/.test(live.session.name))
  throw Error("Isolated acceptance workspace required");
const native =
  "/mnt/c/Users/29461/AppData/Local/Temp/wayfarer-resource-acceptance";
const result = {
  started: new Date().toISOString(),
  dialogMode: "native-windows",
  exports: [],
};
async function until(check, ms = 15000) {
  const at = Date.now();
  while (Date.now() - at < ms) {
    if (await check()) return;
    await sleep(150);
  }
  throw Error("Export step did not complete");
}
async function nativeDialog(destination) {
  const child = spawn(
    process.env.WM_WINDOWS_PYTHON ??
      "/mnt/c/Program Files/Python312/python.exe",
    [
      "C:\\Users\\29461\\AppData\\Local\\Temp\\wayfarer-resource-acceptance\\native-resource-dialog.py",
      "--pid",
      String(root),
      "--path",
      destination,
    ],
  );
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(Error(output)),
    );
  });
  await until(() => output.includes('"ready": true'));
  return { done };
}

try {
  await fs.mkdir(output, { recursive: true });
  await live.command("Workspace Map: 查看机器资源");
  const p = await live.canvas();
  await live.normalizeWindow();
  const value = (code) => live.evaluate(p, code);
  await value('document.querySelector(".breadcrumbs button").click()');
  await until(() =>
    value('document.querySelectorAll(".machine-card").length===4'),
  );
  await until(async () => {
    const s = await live.ipc("systemResources");
    return (
      s.snapshots.length === 4 &&
      s.snapshots.every(
        (s) => s.status === "online" && s.system.cpuPercent != null,
      )
    );
  }, 30000);
  async function click(text) {
    const point = await value(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing export item');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    const r = await live.call(
      "Runtime.evaluate",
      {
        expression:
          "[...document.querySelectorAll('iframe')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>10&&r.height>10).map(r=>({x:r.x,y:r.y}))[0]",
        returnByValue: true,
      },
      live.sid,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await live.call(
        "Input.dispatchMouseEvent",
        {
          type,
          x: point.x + r.result.value.x,
          y: point.y + r.result.value.y,
          button: "left",
          clickCount: 1,
        },
        live.sid,
      );
  }
  for (const format of ["json", "csv"]) {
    const target = path.join(native, "ui-export." + format);
    await fs.rm(target, { force: true });
    const worker = await nativeDialog(
      "C:\\Users\\29461\\AppData\\Local\\Temp\\wayfarer-resource-acceptance\\ui-export." +
        format,
    );
    await value('document.querySelector(".export-menu").open=true');
    await click(format === "json" ? "快照 JSON" : "快照 CSV");
    await worker.done;
    await until(() =>
      fs.stat(target).then(
        (s) => s.size > 10,
        () => false,
      ),
    );
    await sleep(300);
    const text = await fs.readFile(target, "utf8");
    if (format === "json") {
      const snapshots = JSON.parse(text);
      assert.equal(snapshots.length, 4);
      assert.ok(snapshots.every((s) => s.system));
    } else {
      assert.ok(text.includes("systemCpuPercent"));
      assert.ok(text.includes("gpuMemoryUsedBytes"));
      assert.ok(text.includes("gpuSharedMemoryBytes"));
    }
    result.exports.push({
      format,
      bytes: Buffer.byteLength(text),
      valid: true,
    });
  }
  // A GPU/IO observer failure remains within its target, while a separate endpoint stays usable.
  await live.ipc("endpointControl", {
    endpoint: "train",
    action: "disconnect",
  });
  await sleep(2100);
  const offline = await live.ipc("systemResources", {
    endpoint: "train",
    section: "summary",
  });
  assert.equal(offline.status, "offline");
  const peer = await live.ipc("systemResources", {
    endpoint: "infer",
    section: "summary",
  });
  assert.equal(peer.status, "online");
  await live.ipc("endpointControl", { endpoint: "train", action: "connect" });
  const recovered = await live.ipc("systemResources", {
    endpoint: "train",
    section: "gpus",
  });
  assert.equal(recovered.status, "online");
  assert.equal(recovered.gpus.length, 8);
  result.endpointIsolation = {
    disconnectedStatus: offline.status,
    peerStatus: peer.status,
    recoveredGpuCount: recovered.gpus.length,
  };
  const io = await live.ipc("systemResources", {
    endpoint: "windows-c",
    section: "io",
  });
  assert.ok(io.io.volumes.length > 0);
  result.windowsIo = {
    volumes: io.io.volumes.length,
    network: io.io.network.length,
    disks: io.io.disks.length,
  };
  const cpu = await live.ipc("systemResources", {
    endpoint: "windows-c",
    section: "processes",
    limit: 50,
  });
  assert.ok(cpu.total > 0);
  result.windowsProcess = { total: cpu.total, collector: cpu.collector };
  result.complete = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "export-check.json"),
    JSON.stringify(result, null, 2),
  );
  console.log("VS Code exports and endpoint isolation passed");
} catch (error) {
  result.error = String(error);
  await fs.writeFile(
    path.join(output, "export-check.json"),
    JSON.stringify(result, null, 2),
  );
  throw error;
} finally {
  live.close();
}
