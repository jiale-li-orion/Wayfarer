import fs from "node:fs/promises";
import { windowsProcesses, sleep } from "./lib/live.mjs";
const file = process.argv[2];
const seconds = Number(process.env.WM_CONTROL_SECONDS || 600);
if (!file) throw Error("Specify output JSONL");
const rootName =
  process.env.WM_PROFILE_NAME || "workspace-map-profile-control-20261117";
const all = await windowsProcesses(),
  root = all.find(
    (p) => p.command?.includes(rootName) && !p.command.includes("--type="),
  );
if (!root) throw Error("Control window not running");
const owned = new Set([root.pid]),
  start = performance.now();
await fs.writeFile(
  file,
  JSON.stringify({
    kind: "run",
    at: Date.now(),
    rootPid: root.pid,
    extension: "disabled",
    seconds,
  }) + "\n",
);
for (let n = 0; n <= Math.ceil(seconds / 15); n++) {
  const processes = await windowsProcesses();
  let change = true;
  while (change) {
    change = false;
    for (const p of processes)
      if (owned.has(p.parent) && !owned.has(p.pid)) {
        owned.add(p.pid);
        change = true;
      }
  }
  await fs.appendFile(
    file,
    JSON.stringify({
      kind: "sample",
      at: Date.now(),
      elapsedMs: performance.now() - start,
      processes: processes
        .filter((p) => owned.has(p.pid))
        .map(({ command, ...p }) => p),
    }) + "\n",
  );
  if (n < Math.ceil(seconds / 15))
    await sleep(Math.max(0, (n + 1) * 15000 - (performance.now() - start)));
}
console.log(file);
