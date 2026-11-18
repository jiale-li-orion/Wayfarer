/** Read-only comparison on a selected source subtree; transient Core and MCP instance. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { Core } from "../src/core/core";
import { Bridge } from "../src/mcp/bridge";
import { Profiler } from "../src/core/log";
const output = path.resolve(process.argv[2] ?? "artifacts/agent-profile.json");
const root = path.resolve("src"),
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "wm-agent-profile-"));
const core = new Core(
  temp,
  path.resolve("helpers/endpoint.py"),
  new Profiler(() => {}),
);
await core.init([
  { id: "bench", kind: "local", name: "Source benchmark", root },
]);
const mapId = "profile-" + randomUUID(),
  bridge = new Bridge(core, path.resolve("helpers"), "Agent profile", mapId);
await bridge.start();
const child = spawn("python3", ["-u", "helpers/mcp.py", "--map", mapId], {
  stdio: "pipe",
});
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
let seq = 0,
  calls = 0;
child.stderr.on("data", () => {});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id != null) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(Error(m.error.message));
    else p?.resolve(m.result);
  }
});
const request = (method: string, params: any = {}) =>
  new Promise<any>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
const tool = async (name: string, args: any = {}) => {
  calls++;
  const result = await request("tools/call", {
    name: "map_" + name,
    arguments: args,
  });
  if (result.isError) throw Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const measure = async (run: () => Promise<any>) => {
  const start = performance.now();
  const value = await run();
  return {
    ms: performance.now() - start,
    bytes: Buffer.byteLength(JSON.stringify(value)),
    value,
  };
};
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  await request("initialize");
  for (let i = 0; i < 100; i++) {
    if ((await tool("connection")).state === "connected") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const ref = { endpoint: "bench", path: root };
  const full = [],
    small = [],
    cli = [];
  for (let i = 0; i < 5; i++) {
    full.push(await measure(() => tool("list", { ref })));
    small.push(
      await measure(() => tool("list", { ref, fields: ["name", "kind"] })),
    );
    cli.push(
      await measure(async () =>
        execFileSync(
          "find",
          [root, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\t%y\n"],
          { encoding: "utf8" },
        ),
      ),
    );
  }
  await tool("systemResources", {
    endpoint: "bench",
    section: "processes",
    limit: 20,
  });
  const resourceFullRuns = [],
    resourceSmallRuns = [];
  for (let i = 0; i < 5; i++) {
    resourceFullRuns.push(
      await measure(() =>
        tool("systemResources", {
          endpoint: "bench",
          section: "processes",
          limit: 20,
        }),
      ),
    );
    resourceSmallRuns.push(
      await measure(() =>
        tool("systemResources", {
          endpoint: "bench",
          section: "processes",
          limit: 20,
          compact: true,
        }),
      ),
    );
  }
  const resourcesFull = resourceFullRuns[0],
    resourcesSmall = resourceSmallRuns[0];
  const start = performance.now(),
    initial = calls;
  const job = await tool("search", { ref, query: "resource" });
  let result;
  do {
    result = await tool("job", { id: job.id, fields: ["summary", "result"] });
    if (!["completed", "failed", "cancelled"].includes(result.state))
      await new Promise((r) => setTimeout(r, 10));
  } while (!["completed", "failed", "cancelled"].includes(result.state));
  const search = {
    ms: performance.now() - start,
    calls: calls - initial,
    state: result.state,
    matches: result.result?.entries?.length,
  };
  const found = await measure(async () =>
    execFileSync("find", [root, "-iname", "*resource*", "-printf", "%p\n"], {
      encoding: "utf8",
    }),
  );
  const summary = {
    root,
    scope:
      "Warm same-machine source subtree; filename operations. Native metadata and CLI name/type outputs have different richness.",
    list: {
      entries: full[0].value.entries.length,
      full: { medianMs: median(full.map((x) => x.ms)), bytes: full[0].bytes },
      compact: {
        medianMs: median(small.map((x) => x.ms)),
        bytes: small[0].bytes,
      },
      cliFind: {
        medianMs: median(cli.map((x) => x.ms)),
        bytes: Buffer.byteLength(cli[0].value),
      },
    },
    resources: {
      full: {
        medianMs: median(resourceFullRuns.map((x) => x.ms)),
        bytes: resourcesFull.bytes,
      },
      compact: {
        medianMs: median(resourceSmallRuns.map((x) => x.ms)),
        bytes: resourcesSmall.bytes,
      },
    },
    search: {
      mcp: search,
      cli: {
        ms: found.ms,
        matches: found.value.trim().split("\n").filter(Boolean).length,
      },
    },
    payloads: {
      listFull: full[0].value,
      listCompact: small[0].value,
      resourcesFull: resourcesFull.value,
      resourcesCompact: resourcesSmall.value,
    },
  };
  await fs.writeFile(output, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, payloads: undefined }));
} finally {
  child.stdin.end();
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  lines.close();
  bridge.stopIngress();
  await core.dispose();
  await bridge.dispose();
  await fs.rm(temp, { recursive: true, force: true });
}
