import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { connect, sleep } from "./lib/live.mjs";
const output = process.argv[2];
await fs.mkdir(output, { recursive: true });
const live = await connect();
if (!live.session.name.startsWith("acceptance-workspaces "))
  throw Error("Isolated acceptance workspace required");
const result = { started: new Date().toISOString(), endpoints: [], cycles: [] };
let page;
const until = async (fn, ms = 15000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Acceptance condition timed out");
};
const screenshot = async (name) => {
  const r = await live.call(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    live.sid,
  );
  await fs.writeFile(
    path.join(output, name + ".png"),
    Buffer.from(r.data, "base64"),
  );
};
try {
  if (process.env.WM_ENV_RESUME) {
    Object.assign(
      result,
      JSON.parse(
        await fs.readFile(path.join(output, "acceptance.json"), "utf8"),
      ),
    );
    delete result.error;
    await live.command("View: Close Editor");
  } else {
    await live.command("Workspace Map: 查看项目环境");
    page = await live.canvas();
    await until(() =>
      live.evaluate(
        page,
        '!!document.querySelector(".project-environment h3")',
      ),
    );
    const text = await live.evaluate(page, "document.body.innerText");
    assert(text.includes("Python · uv"));
    assert(text.includes("wayfarer-fixture"));
    assert(text.includes(">=3.11"));
    await screenshot("01-project-environment");
    await live.evaluate(
      page,
      '[...document.querySelectorAll("button")].find(e=>e.textContent==="Node").click()',
    );
    await until(() =>
      live.evaluate(page, 'document.body.innerText.includes("npm@10")'),
    );
    await screenshot("02-node-environment");
    await live.command("View: Close Editor");
    assert.equal((await live.ipc("diagnostics")).environmentUi.panels, 0);
    await live.command("Workspace Map: 收藏当前工作区");
    await sleep(250);
    await live.call(
      "Input.insertText",
      { text: "Acceptance Favorite" },
      live.sid,
    );
    await live.key("Enter", "Enter", 13);
    await until(async () =>
      (await live.ipc("workspaces")).some(
        (w) => w.name === "Acceptance Favorite",
      ),
    );
    await live.command("Workspace Map: 显示侧边栏");
    await screenshot("03-favorite-workspace");
  }
  for (
    let i = result.cycles.length;
    i < Number(process.env.WM_ENV_CYCLE_TARGET ?? 50);
    i++
  ) {
    const point = await live.call(
      "Runtime.evaluate",
      {
        expression: `(()=>{const e=[...document.querySelectorAll('.monaco-list-row')].find(e=>e.textContent.includes('当前工作区环境'));if(!e)throw Error('Environment sidebar action absent');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        returnByValue: true,
      },
      live.sid,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await live.call(
        "Input.dispatchMouseEvent",
        { type, ...point.result.value, button: "left", clickCount: 1 },
        live.sid,
      );
    page = await live.canvas();
    await until(() =>
      live.evaluate(
        page,
        '!!document.querySelector(".project-environment h3")',
      ),
    );
    const close = await live.call(
      "Runtime.evaluate",
      {
        expression:
          "(()=>{const e=document.querySelector('.tab.active [class*=codicon-close]');if(!e)throw Error('Editor close action absent');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
        returnByValue: true,
      },
      live.sid,
    );
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await live.call(
        "Input.dispatchMouseEvent",
        { type, ...close.result.value, button: "left", clickCount: 1 },
        live.sid,
      );
    await until(
      async () => (await live.ipc("diagnostics")).environmentUi.panels === 0,
    );

    const d = await live.ipc("diagnostics");
    assert.equal(d.environmentUi.panels, 0);
    assert.equal(d.inspector.pending, 0);
    result.cycles.push({
      i,
      panels: d.environmentUi.panels,
      snapshots: d.inspector.snapshots,
      heap: d.host.memory.heapUsed,
      agents: d.agents,
    });
    await fs.writeFile(
      path.join(output, "acceptance.json"),
      JSON.stringify(result, null, 2),
    );
  }
  result.endpoints = [];
  const endpoints = await live.ipc("endpoints");
  for (const id of ["windows-d", "wsl-ubuntu", "train", "infer"]) {
    const e = endpoints.find((e) => e.id === id);
    assert(e, "Missing endpoint " + id);
    const root =
      id === "windows-d"
        ? "D:\\Wayfarer-Acceptance\\v050\\中文 fixture"
        : id === "train"
          ? "/data/users/lijiale/projects/agent-system-learning/workspace-map"
          : id === "infer"
            ? "/home/jiale/s20/current"
            : "/home/orion/agent-system-learning/workspace-map";
    const ref = { endpoint: id, path: root };
    const started = performance.now();
    const value = await live.ipc("inspect", {
      ref,
      environment: true,
      refresh: true,
    });
    const coldMs = performance.now() - started;
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await live.ipc("inspect", { ref, environment: true });
      times.push(performance.now() - t);
    }
    const discovery = await live.ipc("packageDiscover", {
      endpoint: id,
      cwd: root,
    });
    const job = await live.ipc("inventory", {
      endpoint: id,
      cwd: root,
      ecosystem: "python",
      refresh: true,
    });
    let full;
    await until(async () => {
      full = await live.ipc("job", { id: job.id });
      return ["completed", "failed", "cancelled"].includes(full.state);
    }, 45000);
    assert.equal(full.state, "completed", full.error);
    result.endpoints.push({
      id,
      coldMs,
      cacheP50: times.sort((a, b) => a - b)[10],
      declarations: {
        python: value.value.python.name,
        node: value.value.node.name,
      },
      tools: discovery,
      inventory: {
        state: full.state,
        tools: full.result.value.tools.map((t) => ({
          name: t.name,
          path: t.path,
          exitCode: t.exitCode,
          output: t.output?.trim().split("\n")[0],
        })),
      },
    });
  }
  result.diagnostics = await live.ipc("diagnostics");
  result.completed = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      cycles: result.cycles.length,
      endpoints: result.endpoints.map((e) => e.id),
    }),
  );
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
