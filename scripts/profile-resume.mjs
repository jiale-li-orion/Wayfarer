// Linux acceptance fixture. node --expose-gc --import tsx scripts/profile-resume.mjs output.json
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Core } from "../src/core/core.ts";
import { Profiler } from "../src/core/log.ts";
import { Bridge } from "../src/mcp/bridge.ts";
const output = process.argv[2];
if (!output) throw Error("Specify output JSON");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-resume-profile-"));
const previousHome = process.env.HOME;
process.env.HOME = root;
const cores = [],
  bridges = [];
const data = {
  at: new Date().toISOString(),
  node: process.version,
  cycles: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child, lines;
try {
  for (const id of ["a", "b"]) {
    const core = new Core(
      path.join(root, id),
      path.resolve("helpers/endpoint.py"),
      new Profiler(() => {}),
    );
    await core.init();
    const bridge = new Bridge(core, path.resolve("helpers"), "same-name", id);
    await bridge.start();
    cores.push(core);
    bridges.push(bridge);
  }
  child = spawn("python3", ["-u", "helpers/mcp.py", "--map", "a"], {
    stdio: "pipe",
  });
  const pending = new Map();
  let seq = 0;
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const m = JSON.parse(line);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const tool = async (name, args = {}) => {
    const result = await rpc("tools/call", {
      name: "map_" + name,
      arguments: args,
    });
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const ready = async () => {
    const end = Date.now() + 5000;
    for (;;) {
      const c = await tool("connection");
      if (c.state === "connected") return c;
      if (Date.now() > end) throw Error("Connection wait expired");
      await sleep(5);
    }
  };
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  await ready();
  for (let i = 1; i <= 50; i++) {
    await tool("bind", { mapId: i % 2 ? "b" : "a" });
    const state = await ready();
    if (i % 10 === 0) {
      await sleep(20);
      global.gc?.();
      data.cycles.push({
        cycle: i,
        client: state.resources,
        clientFDs: (await fs.readdir("/proc/" + state.resources.pid + "/fd"))
          .length,
        host: process.memoryUsage(),
        bridges: bridges.map((b) => b.stats()),
        directories: cores.map((c) => c.directories.stats()),
      });
    }
  }
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  await sleep(20);
  for (const bridge of bridges) bridge.stopIngress();
  for (const core of cores) await core.dispose();
  for (const bridge of bridges) await bridge.dispose();
  global.gc?.();
  data.closed = {
    host: process.memoryUsage(),
    bridges: bridges.map((b) => b.stats()),
    directories: cores.map((c) => c.directories.stats()),
    jobs: cores.map((c) => c.jobs.stats()),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(data, null, 2) + "\n");
  console.log(output);
} finally {
  child?.kill("SIGKILL");
  lines?.close();
  for (const bridge of bridges) bridge.stopIngress();
  for (const core of cores) await core.dispose();
  for (const bridge of bridges) await bridge.dispose();
  process.env.HOME = previousHome;
  await fs.rm(root, { recursive: true, force: true });
}
