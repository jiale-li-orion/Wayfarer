// Run against an isolated installed Windows VS Code window from WSL.
import fs from "node:fs/promises";
import path from "node:path";
import { connect, sleep, windowsProcesses } from "./lib/live.mjs";
const out = process.argv[2];
if (!out) throw Error("Specify output JSONL");
await fs.mkdir(path.dirname(out), { recursive: true });
const live = await connect(),
  { ipc } = live;
const seconds = Number(process.env.WM_PHASE_SECONDS || 600),
  interval = 15000;
const append = async (value) =>
  fs.appendFile(out, JSON.stringify({ at: Date.now(), ...value }) + "\n");
const config = process.env.WM_SSH_CONFIG;
if (!config) throw Error("Set WM_SSH_CONFIG");
const endpointDefs = [
  {
    id: "profile-train",
    kind: "ssh",
    name: "Profile train",
    host: "gpu-lab",
    root: "/home/lijiale",
    sshConfig: config,
    distro: "Ubuntu",
    python: "python3",
  },
  {
    id: "profile-infer",
    kind: "ssh",
    name: "Profile infer",
    host: "serve-lab",
    root: "/home/jiale",
    sshConfig: config,
    distro: "Ubuntu",
    python: "python3",
  },
];
const refs = [
  { endpoint: "windows-c", path: "C:\\Users\\29461" },
  { endpoint: "wsl-ubuntu", path: "/home/orion" },
  ...endpointDefs.map((e) => ({ endpoint: e.id, path: e.root })),
];
try {
  const windowState = await live.normalizeWindow();
  if (windowState.visiblePanels.length)
    throw Error(
      "Acceptance panels remain visible: " + JSON.stringify(windowState),
    );
  await live.command("Workspace Map: 打开目录地图");
  for (const e of endpointDefs) await ipc("addEndpoint", e);
  const endpoints = await ipc("endpoints");
  const roots = refs.map((r) => ({
    endpoint: r.endpoint,
    path: endpoints.find((e) => e.id === r.endpoint).root,
  }));
  for (const ref of refs) {
    const p = await ipc("list", { ref, refresh: true });
    if (p.error) throw Error(p.error);
  }
  const processes = await windowsProcesses();
  const root = processes.find(
    (p) =>
      p.command?.includes(
        process.env.WM_PROFILE_NAME || "workspace-map-profile-20261117",
      ) && !p.command.includes("--type="),
  );
  if (!root) throw Error("Isolated Code root not found");
  const owned = new Set([root.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of processes)
      if (owned.has(p.parent) && !owned.has(p.pid)) {
        owned.add(p.pid);
        changed = true;
      }
  }
  await append({
    kind: "run",
    session: live.session.id,
    seconds,
    rootPid: root.pid,
    windowState,
    processes: processes.map(({ command, ...p }) => ({
      ...p,
      scope: owned.has(p.pid) ? "isolated" : "user-window",
      role: command?.match(/--type=([^ ]+)/)?.[1] || "browser",
    })),
  });
  const phases = (process.env.WM_PHASES || "connected,canvas,hidden").split(
    ",",
  );
  if (phases[0] === "hidden") {
    await ipc("setView", {
      expanded: roots.map((r) => JSON.stringify([r.endpoint, r.path])),
      follow: true,
    });
    await ipc("navigate", {});
    await sleep(1500);
  }
  for (const phase of phases) {
    if (phase === "connected") {
      await ipc("setView", { expanded: [], follow: true });
      await ipc("navigate", {});
    }
    if (phase === "canvas") {
      await ipc("setView", {
        expanded: roots.map((r) => JSON.stringify([r.endpoint, r.path])),
        follow: true,
      });
      await ipc("navigate", {});
      await sleep(1500);
    }
    if (phase === "hidden") await live.command("File: New Text File");
    let canvas = phase === "hidden" ? null : await live.canvas();
    await append({ kind: "phase", phase, seconds });
    console.log("phase", phase, "started", new Date().toISOString());
    const start = performance.now();
    let tick = 0;
    do {
      const resources = await Promise.all(
        refs.map(async (r) => ({
          endpoint: r.endpoint,
          ...(await ipc("resources", { endpoint: r.endpoint })),
        })),
      );
      const procs = await windowsProcesses();
      for (const p of procs) if (owned.has(p.parent)) owned.add(p.pid);
      await append({
        kind: "sample",
        phase,
        elapsedMs: performance.now() - start,
        resources,
        diagnostics: await ipc("diagnostics").catch(() => null),
        canvas: canvas ? await live.sampleCanvas(canvas) : null,
        processes: procs.map(({ command, ...p }) => ({
          ...p,
          scope: owned.has(p.pid) ? "isolated" : "user-window",
        })),
      });
      tick++;
      await sleep(
        Math.max(
          0,
          Math.min(tick * interval, seconds * 1000) -
            (performance.now() - start),
        ),
      );
    } while (performance.now() - start < seconds * 1000);
    await append({
      kind: "phaseEnd",
      phase,
      elapsedMs: performance.now() - start,
    });
  }
  await live.command("Workspace Map: 打开目录地图");
  await ipc("setView", { expanded: [], follow: false });
  await append({ kind: "completed" });
} finally {
  live.close();
}
