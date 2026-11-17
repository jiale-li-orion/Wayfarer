import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function connect() {
  const dir = path.join(os.homedir(), ".local/share/workspace-map/sessions");
  const records = await Promise.all(
    (await fs.readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .map(async (f) =>
        JSON.parse(await fs.readFile(path.join(dir, f), "utf8")),
      ),
  );
  const session = records.find((r) => r.id === process.env.WM_SESSION);
  if (!session)
    throw Error("Set WM_SESSION to the isolated acceptance window session");
  const ipc = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = randomUUID(),
        c = net.createConnection(session.socket);
      let buffer = "";
      c.on("connect", () =>
        c.write(JSON.stringify({ id, method, args }) + "\n"),
      );
      c.on("error", reject);
      c.on("data", (b) => {
        buffer += b;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const m = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          if (m.id === id) {
            c.end();
            m.error ? reject(Error(m.error)) : resolve(m.result);
          }
        }
      });
      c.on("end", () => reject(Error("IPC closed before reply")));
    });
  const v = await (
    await fetch(
      `http://127.0.0.1:${process.env.WM_CDP_PORT || 9231}/json/version`,
    )
  ).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map(),
    contexts = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p)
        m.error
          ? p.reject(Error(JSON.stringify(m.error)))
          : p.resolve(m.result);
    }
    if (m.method === "Runtime.executionContextCreated")
      contexts.push({ session: m.sessionId, ...m.params.context });
    if (
      m.method === "Runtime.executionContextDestroyed" ||
      m.method === "Runtime.executionContextsCleared"
    ) {
      for (let i = contexts.length - 1; i >= 0; i--)
        if (
          contexts[i].session === m.sessionId &&
          (m.method.endsWith("Cleared") ||
            contexts[i].id === m.params.executionContextId)
        )
          contexts.splice(i, 1);
    }
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      let id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const targets = () => call("Target.getTargets").then((r) => r.targetInfos);
  const page = (await targets()).find(
    (t) => t.type === "page" && t.url.startsWith("vscode-file:"),
  );
  const sid = (
    await call("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })
  ).sessionId;
  const key = async (key, code, num, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"])
      await call(
        "Input.dispatchKeyEvent",
        { type, key, code, windowsVirtualKeyCode: num, modifiers },
        sid,
      );
  };
  const command = async (text) => {
    if (
      !/^acceptance(?:-[a-z-]+)? \((?:Workspace|工作区)\)(?: \[WSL: [^\]]+\])?$/.test(
        session.name,
      )
    )
      throw Error("Use an isolated acceptance window");
    const title = session.name.replaceAll("'", "''");
    const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MapWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
$p=Get-Process Code | Where-Object { $_.MainWindowTitle.Contains('${title}') } | Select-Object -First 1
if (!$p) { throw 'Acceptance window missing' }
[MapWindow]::ShowWindow($p.MainWindowHandle,9) | Out-Null
[MapWindow]::SetForegroundWindow($p.MainWindowHandle) | Out-Null`;
    await execute(
      process.env.WM_POWERSHELL ||
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    );
    await call("Page.bringToFront", {}, sid);
    await key("Escape", "Escape", 27);
    if (text === "File: New Text File") {
      await key("n", "KeyN", 78, 2);
      await sleep(400);
      return;
    }
    if (text === "View: Close Editor") {
      await key("w", "KeyW", 87, 2);
      await sleep(400);
      return;
    }
    await key("P", "KeyP", 80, 10);
    await sleep(200);
    const palette = await call(
      "Runtime.evaluate",
      {
        expression:
          "(()=>{const i=document.querySelector('.quick-input-widget input');if(!i || i.getBoundingClientRect().width===0)throw Error('Command palette absent');i.focus();i.select()})()",
      },
      sid,
    );
    if (palette.exceptionDetails)
      throw Error("Command palette not focused; no text inserted");
    await call("Input.insertText", { text: ">" + text }, sid);
    await sleep(350);
    await key("Enter", "Enter", 13);
    await sleep(500);
  };
  async function normalizeWindow() {
    await call("Page.bringToFront", {}, sid);
    for (const [selector, k, code, num, modifiers] of [
      [".part.panel", "j", "KeyJ", 74, 2],
      [".part.auxiliarybar", "b", "KeyB", 66, 3],
      [".part.sidebar", "b", "KeyB", 66, 2],
    ]) {
      const visible = (
        await call(
          "Runtime.evaluate",
          {
            expression: `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e && e.getBoundingClientRect().width>1})()`,
            returnByValue: true,
          },
          sid,
        )
      ).result.value;
      if (visible) {
        await key(k, code, num, modifiers);
        await sleep(200);
      }
    }
    return (
      await call(
        "Runtime.evaluate",
        {
          expression:
            '({width:innerWidth,height:innerHeight,visiblePanels:[...document.querySelectorAll(".part.panel,.part.sidebar,.part.auxiliarybar")].filter(e=>e.getBoundingClientRect().width>1).map(e=>e.className)})',
          returnByValue: true,
        },
        sid,
      )
    ).result.value;
  }
  let canvasTarget, canvasSession;
  async function canvas() {
    if (canvasSession)
      await call("Target.detachFromTarget", { sessionId: canvasSession }).catch(
        () => {},
      );
    canvasSession = undefined;
    canvasTarget = undefined;
    for (let n = 0; n < 200; n++) {
      const t = (await targets()).find(
        (t) =>
          t.type === "iframe" &&
          t.url.includes("extensionId=orion-workspace.workspace-map"),
      );
      if (t) {
        if (canvasTarget !== t.targetId) {
          if (canvasSession)
            await call("Target.detachFromTarget", {
              sessionId: canvasSession,
            }).catch(() => {});
          canvasTarget = t.targetId;
          canvasSession = (
            await call("Target.attachToTarget", {
              targetId: t.targetId,
              flatten: true,
            })
          ).sessionId;
          await call("Runtime.enable", {}, canvasSession);
        }
        const s = canvasSession;
        const nested = await call(
          "Runtime.evaluate",
          {
            expression:
              '!!document.getElementById("active-frame")?.contentDocument?.getElementById("root")?.childElementCount',
            returnByValue: true,
          },
          s,
        );
        if (nested.result?.value) {
          await call("Performance.enable", {}, s);
          return { session: s, nested: true };
        }
        for (const c of contexts.filter((c) => c.session === s).reverse()) {
          const r = await call(
            "Runtime.evaluate",
            {
              contextId: c.id,
              expression:
                '!!document.getElementById("root")?.childElementCount',
              returnByValue: true,
            },
            s,
          );
          if (r.result?.value) {
            await call(
              "Emulation.setFocusEmulationEnabled",
              { enabled: true },
              s,
            );
            await call("Performance.enable", {}, s);
            return { session: s, context: c.id };
          }
        }
      }
      await sleep(100);
    }
    throw Error("Map canvas not ready");
  }
  const evaluate = async (c, expression, awaitPromise = false) => {
    if (c.nested)
      expression = `((document,window)=>(${expression}))(document.getElementById("active-frame").contentDocument,document.getElementById("active-frame").contentWindow)`;
    const r = await call(
      "Runtime.evaluate",
      { contextId: c.context, expression, returnByValue: true, awaitPromise },
      c.session,
    );
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const sampleCanvas = async (c) => ({
    metrics: (await call("Performance.getMetrics", {}, c.session)).metrics,
    dom: await call("Memory.getDOMCounters", {}, c.session),
    visibility: await evaluate(c, "document.visibilityState"),
  });
  const finish = async (job) => {
    while (true) {
      const j = await ipc("job", { id: job.id });
      if (j.state === "completed") return j;
      if (["failed", "paused", "cancelled"].includes(j.state))
        throw Error(JSON.stringify(j));
      await sleep(100);
    }
  };
  return {
    session,
    ipc,
    ws,
    call,
    targets,
    sid,
    key,
    command,
    canvas,
    evaluate,
    sampleCanvas,
    normalizeWindow,
    finish,
    close: () => ws.close(),
  };
}
const execute = promisify(execFile);
export async function windowsProcesses() {
  const ps =
    process.env.WM_POWERSHELL ||
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const script =
    "$rows=Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\"; @($rows | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;command=$_.CommandLine;cpuSeconds=$p.CPU;rss=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;handles=$p.HandleCount;threads=$p.Threads.Count}}}) | ConvertTo-Json -Compress";
  return JSON.parse(
    (
      await execute(ps, ["-NoProfile", "-Command", script], {
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.replace(/^\uFEFF/, ""),
  );
}
