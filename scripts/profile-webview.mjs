import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
const port = Number(process.env.WM_CDP_PORT ?? 9231);
const root = path.join(os.homedir(), ".local/share/workspace-map/sessions");
const sessions = await Promise.all(
  (await fs.readdir(root))
    .filter((f) => f.endsWith(".json"))
    .map(async (f) =>
      JSON.parse(await fs.readFile(path.join(root, f), "utf8")),
    ),
);
const map = sessions.sort((a, b) => b.created - a.created)[0];
function ipc(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const c = net.createConnection(map.socket);
    let buffer = "";
    c.on("connect", () => c.write(JSON.stringify({ id, method, args }) + "\n"));
    c.on("error", reject);
    c.on("data", (b) => {
      buffer += b;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const m = JSON.parse(line);
        if (m.id === id) {
          c.end();
          m.error ? reject(Error(m.error)) : resolve(m.result);
        }
      }
    });
  });
}
const version = await (
  await fetch("http://127.0.0.1:" + port + "/json/version")
).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let sequence = 0;
const waiting = new Map();
const contexts = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  }
  if (m.method === "Runtime.executionContextCreated")
    contexts.push({ session: m.sessionId, ...m.params.context });
};
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, (m) =>
      m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result),
    );
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
await new Promise((r) => (ws.onopen = r));
const targets = (await call("Target.getTargets")).targetInfos;
const target = targets.find(
  (t) =>
    t.type === "iframe" &&
    t.url.includes("extensionId=orion-workspace.workspace-map"),
);
if (!target)
  throw Error("Open Workspace Map in the acceptance VS Code window first");
const sid = (
  await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })
).sessionId;
await call("Runtime.enable", {}, sid);
await call("Emulation.setFocusEmulationEnabled", { enabled: true }, sid);
let context;
for (const c of contexts.filter((c) => c.session === sid)) {
  const v = await call(
    "Runtime.evaluate",
    {
      contextId: c.id,
      expression: '!!document.getElementById("root")',
      returnByValue: true,
    },
    sid,
  );
  if (v.result.value) context = c.id;
}
if (!context) throw Error("Canvas runtime context not found");
const evaluate = async (expression, awaitPromise = false) =>
  (
    await call(
      "Runtime.evaluate",
      { contextId: context, expression, returnByValue: true, awaitPromise },
      sid,
    )
  ).result.value;
await call("Performance.enable", {}, sid);
const sample = async () => ({
  metrics: (await call("Performance.getMetrics", {}, sid)).metrics,
  dom: await call("Memory.getDOMCounters", {}, sid),
  processes: (await call("SystemInfo.getProcessInfo")).processInfo.map(
    ({ id, type, cpuTime }) => ({ id, type, cpuTime }),
  ),
  visible: await evaluate(
    'document.querySelectorAll(".react-flow__node").length',
  ),
});
const prior = await ipc("view");
if (prior.root?.path?.startsWith("/tmp/workspace-map-ui-")) {
  prior.root = undefined;
  prior.expanded = [];
}
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-map-ui-"));
const ref = { endpoint: "wsl-ubuntu", path: fixture };
const expanded = [JSON.stringify([ref.endpoint, ref.path])];
const results = {};
try {
  for (let g = 0; g < 5; g++) {
    const dir = path.join(fixture, "Project " + g);
    await fs.mkdir(dir);
    expanded.push(JSON.stringify([ref.endpoint, dir]));
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        fs.writeFile(path.join(dir, "文件 " + i + ".txt"), "fixture"),
      ),
    );
  }
  await ipc("setView", { expanded, follow: true });
  await ipc("navigate", { ref });
  for (let n = 0; n < 100; n++) {
    const text = await evaluate(
      'document.querySelector(".status")?.textContent??""',
    );
    if (/1,?01[01] 节点/.test(text) || /1006 节点/.test(text)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log("1000-node branches loaded");
  results.loaded = await evaluate(
    '({status:document.querySelector(".status")?.textContent,labels:document.querySelectorAll(".node-label").length})',
  );
  results.idleBefore = await sample();
  await new Promise((r) => setTimeout(r, 2000));
  results.idleAfter = await sample();
  await evaluate(
    "document.querySelector('button[title=\"定位全部已加载节点\"]').click()",
  );
  await new Promise((r) => setTimeout(r, 200));
  results.overview = await sample();
  console.log("overview metrics sampled");
  results.interactionBefore = await sample();
  results.frames = await evaluate(
    'new Promise(resolve=>{const pane=document.querySelector(".react-flow__pane");const intervals=[];let last=performance.now(),n=0;function step(now){intervals.push(now-last);last=now;pane.dispatchEvent(new WheelEvent("wheel",{deltaY:n%2?10:-10,clientX:400,clientY:300,bubbles:true,cancelable:true}));if(++n<120)requestAnimationFrame(step);else resolve({count:n,averageMs:intervals.reduce((a,b)=>a+b,0)/n,maxMs:Math.max(...intervals),p95Ms:[...intervals].sort((a,b)=>a-b)[Math.floor(n*.95)]});}requestAnimationFrame(step);})',
    true,
  );
  results.interactionAfter = await sample();
  console.log("interaction sampled");
  await ipc("setView", { expanded: [], follow: true });
  await ipc("navigate", {});
  await new Promise((r) => setTimeout(r, 300));
  await call("HeapProfiler.collectGarbage", {}, sid);
  results.collapsed = await sample();
} finally {
  await ipc("setView", {
    expanded: prior.expanded,
    viewport: prior.viewport,
    bookmarks: prior.bookmarks,
    follow: true,
  });
  await ipc("navigate", { ref: prior.root });
  await ipc("setView", { follow: false });
  await fs.rm(fixture, { recursive: true, force: true });
  ws.close();
}
const out = process.argv[2] ?? "profile-webview.json";
await fs.writeFile(out, JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    {
      output: out,
      loaded: results.loaded,
      frames: results.frames,
      overviewVisible: results.overview?.visible,
    },
    null,
    2,
  ),
);
