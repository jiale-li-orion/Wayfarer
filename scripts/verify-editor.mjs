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
  path.join(os.tmpdir(), "workspace-map-editor-"),
);
const file = path.join(fixture, "编辑测试.txt");
await fs.writeFile(file, "workspace-map-editor-before");
await ipc("setView", {
  expanded: [JSON.stringify(["wsl-ubuntu", fixture])],
  follow: true,
});
await ipc("navigate", { ref: { endpoint: "wsl-ubuntu", path: fixture } });
for (let i = 0; i < 100; i++) {
  if (
    await evaluate(
      '[...document.querySelectorAll(".node-label")].some(n=>n.title===' +
        JSON.stringify(file) +
        ")",
    )
  )
    break;
  await new Promise((r) => setTimeout(r, 50));
}
await evaluate(
  '(()=>{const n=[...document.querySelectorAll(".node-label")].find(n=>n.title===' +
    JSON.stringify(file) +
    ');if(!n)throw Error("File node missing");n.closest(".react-flow__node").dispatchEvent(new MouseEvent("dblclick",{bubbles:true,detail:2}));})()',
);
await fs.writeFile(
  process.argv[2],
  JSON.stringify({ fixture, file, session: map.id }, null, 2),
);
console.log(file);
ws.close();
