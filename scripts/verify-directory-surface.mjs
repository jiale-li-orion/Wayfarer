import { connect, sleep } from "./lib/live.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const out = process.argv[2],
  mode = process.argv[3];
if (!out || !["baseline", "candidate"].includes(mode))
  throw Error("Output and baseline/candidate required");
const live = await connect(),
  note = { mode, started: Date.now() };
assert(live.session.name.startsWith("acceptance-surface "));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wayfarer-surface-")),
  ref = { endpoint: "wsl-ubuntu", path: dir };
const navigate = async (ref) => {
  await live.ipc("setView", { follow: true });
  await live.ipc("navigate", { ref });
};
const wait = async (fn, ms = 45000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(120);
  }
  throw Error("Map condition timed out");
};
try {
  const expanded = [JSON.stringify([ref.endpoint, dir])];
  for (let i = 0; i < 5; i++) {
    const sub = path.join(dir, "group-" + i);
    await fs.mkdir(sub);
    expanded.push(JSON.stringify([ref.endpoint, sub]));
    await Promise.all(
      Array.from({ length: 200 }, (_, j) =>
        fs.writeFile(path.join(sub, "item-" + j), "x"),
      ),
    );
  }
  await live.command("Workspace Map: 打开目录地图");
  const page = await live.canvas();
  const read = (expr, async = false) => live.evaluate(page, expr, async);
  await live.normalizeWindow();
  await live.ipc("setView", { expanded });
  const start = performance.now();
  await navigate(ref);
  await wait(
    async () =>
      parseInt(
        await read('document.querySelector(".status span")?.textContent'),
      ) >= 1006,
  );
  note.loadMs = performance.now() - start;
  note.nodes = await read('document.querySelector(".status span").textContent');
  await read(
    "document.querySelector('button[title=\"定位全部已加载节点\"]').click()",
  );
  await sleep(300);
  note.frames = await read(
    'new Promise(resolve=>{const pane=document.querySelector(".react-flow__pane"),frames=[];let last;function tick(now){if(last!==undefined)frames.push(now-last);last=now;pane.dispatchEvent(new window.WheelEvent("wheel",{deltaY:frames.length%2?10:-10,clientX:400,clientY:300,bubbles:true,cancelable:true}));if(frames.length>=120){frames.sort((a,b)=>a-b);resolve({p50:frames[59],p95:frames[113],max:frames[119]});}else window.requestAnimationFrame(tick);}window.requestAnimationFrame(tick);})',
    true,
  );
  note.steadyStart = Date.now();
  await sleep(11000);
  note.steadyEnd = Date.now();
  if (mode === "candidate") {
    await live.ipc("workloadRegister", {
      runId: "surface-test",
      name: "目录观测验收",
      endpoint: ref.endpoint,
      projectRef: ref,
      step: 1,
      state: "running",
    });
    await wait(
      async () =>
        parseInt(
          await read('document.querySelector(".status span")?.textContent'),
        ) > parseInt(note.nodes),
    );
    await sleep(900);
    note.metricStart = Date.now();
    await live.ipc("workloadRegister", {
      runId: "surface-test",
      endpoint: ref.endpoint,
      step: 2,
    });
    await sleep(11000);
    note.metricEnd = Date.now();
  }
} finally {
  if (mode === "candidate")
    await live.ipc("workloadForget", { runId: "surface-test" }).catch(() => {});
  await live.ipc("setView", { expanded: [], follow: true });
  await navigate(undefined);
  await live.ipc("setView", { follow: false });
  await fs.rm(dir, { recursive: true, force: true });
  await fs.writeFile(
    path.join(out, mode + ".json"),
    JSON.stringify(note, null, 2),
  );
  live.close();
}
