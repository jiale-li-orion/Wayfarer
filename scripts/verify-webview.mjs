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
const map = sessions.find(s => s.id === process.env.WM_SESSION);
if (!map) throw Error("Set WM_SESSION to the isolated acceptance window");
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
const evaluate = async (expression, awaitPromise = false) => {
  const reply = await call(
    "Runtime.evaluate",
    { contextId: context, expression, returnByValue: true, awaitPromise },
    sid,
  );
  if (reply.exceptionDetails)
    throw Error(
      reply.exceptionDetails.exception?.description ??
        reply.exceptionDetails.text,
    );
  return reply.result.value;
};
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
const fixture = await fs.mkdtemp(
  path.join(os.tmpdir(), "workspace-map-actions-"),
);
const prior = await ipc("view");
const rootRef = { endpoint: "wsl-ubuntu", path: fixture };
const source = path.join(fixture, "中文 文件.txt"),
  destination = path.join(fixture, "目标目录");
await fs.writeFile(source, "workspace-map-drag-test");
await fs.mkdir(destination);
const results = {};
try {
  await ipc("setView", {
    expanded: [JSON.stringify([rootRef.endpoint, fixture])],
    follow: true,
  });
  await ipc("navigate", { ref: rootRef });
  for (let i = 0; i < 50; i++) {
    if (
      await evaluate(
        '[...document.querySelectorAll(".node-label")].some(n=>n.title===' +
          JSON.stringify(source) +
          ')&&[...document.querySelectorAll(".node-label")].some(n=>n.title===' +
          JSON.stringify(destination) +
          ")",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const expression =
    '(()=>{const labels=[...document.querySelectorAll(".node-label")];const source=labels.find(n=>n.title===' +
    JSON.stringify(source) +
    ')?.closest(".file-node");const destination=labels.find(n=>n.title===' +
    JSON.stringify(destination) +
    ')?.closest(".file-node");if(!source||!destination)throw Error("fixture nodes not visible");const transfer=new DataTransfer();source.querySelector(".move-handle").dispatchEvent(new DragEvent("dragstart",{dataTransfer:transfer,bubbles:true,cancelable:true}));destination.dispatchEvent(new DragEvent("dragover",{dataTransfer:transfer,bubbles:true,cancelable:true}));destination.dispatchEvent(new DragEvent("drop",{dataTransfer:transfer,bubbles:true,cancelable:true}));return transfer.getData("application/workspace-map");})()';
  results.handlePayload = await evaluate(expression);
  await new Promise((r) => setTimeout(r, 100));
  results.dialog = await evaluate(
    'document.querySelector("[role=dialog]")?.textContent',
  );
  if (!results.dialog?.includes("开始移动"))
    throw Error("Move dialog did not open");
  await evaluate('document.querySelector(".modal .primary").click()');
  for (let i = 0; i < 50; i++) {
    if (
      await fs.stat(path.join(destination, path.basename(source))).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  results.moved = await fs.readFile(
    path.join(destination, path.basename(source)),
    "utf8",
  );
  if (results.moved !== "workspace-map-drag-test")
    throw Error("Moved file content mismatch");
  results.sourceRemoved = !(await fs.stat(source).then(
    () => true,
    () => false,
  ));
  console.log("drag move:", results.sourceRemoved);
  await new Promise((r) => setTimeout(r, 600));
  await evaluate(
    '(()=>{const n=[...document.querySelectorAll(".node-label")].find(n=>n.title===' +
      JSON.stringify(destination) +
      ');if(!n)throw Error("destination node not visible");n.closest(".react-flow__node").dispatchEvent(new MouseEvent("dblclick",{bubbles:true,detail:2}));})()',
  );
  await new Promise((r) => setTimeout(r, 600));
  results.subtree = (await ipc("view")).root;
  if (results.subtree.path !== destination)
    throw Error("Double click did not enter subtree");
  const history = await ipc("history", { direction: -1 });
  results.back = history.root;
  if (history.root.path !== fixture)
    throw Error("Back navigation did not restore parent");
} finally {
  await fs.writeFile(
    process.argv[2] ?? "ui-actions.json",
    JSON.stringify(results, null, 2),
  );
  await ipc("setView", { expanded: [], follow: true });
  await ipc("navigate", {});
  await ipc("setView", { follow: false });
  await fs.rm(fixture, { recursive: true, force: true });
  ws.close();
}
await fs.writeFile(
  process.argv[2] ?? "ui-actions.json",
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
