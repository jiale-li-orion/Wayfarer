import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
import { alias } from "../src/shared/paths";
import { recipe } from "../src/packages/catalog";
test("portable native fixture opens, copies and reports immediate project markers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-portable-"));
  const core = new Core(
    path.join(dir, "state"),
    path.resolve("helpers/endpoint.py"),
    new Profiler(() => {}),
  );
  try {
    const src = path.join(dir, "中文 source"),
      dst = path.join(dir, "target");
    await fs.mkdir(src);
    await fs.mkdir(dst);
    await fs.writeFile(path.join(src, "package.json"), "{}");
    await core.init([
      {
        id: "fixture",
        name: "Fixture",
        kind: process.platform === "win32" ? "windows" : "local",
        root: dir,
      },
    ]);
    const ref = { endpoint: "fixture", path: src };
    const info = await core.dispatch("inspect", { ref });
    assert(info.value.tags.includes("Node"));
    const j = await core.dispatch("transfer", {
      sources: [{ ...ref, path: path.join(src, "package.json") }],
      target: { ...ref, path: dst },
      mode: "copy",
      conflict: "skip",
    });
    while (["running", "queued"].includes(core.jobs.get(j.id).state))
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(core.jobs.get(j.id).state, "completed");
    assert.equal(
      await fs.readFile(path.join(dst, "package.json"), "utf8"),
      "{}",
    );
    const page = await core.dispatch("jobsPage", { limit: 1 });
    assert.equal(page.history[0].id, j.id);
  } finally {
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("portable Windows aliases and command plans retain explicit target environment", () => {
  const e = { id: "win", kind: "windows" as const, name: "Win", root: "C:\\" };
  assert.equal(alias(e, "C:\\Users\\Example"), alias(e, "c:\\users\\example"));
  const plan = recipe({
    endpoint: "win",
    cwd: "C:\\project",
    manager: "pip",
    action: "list",
    python: "C:\\project\\.venv\\Scripts\\python.exe",
  });
  assert.equal(plan.argv[0], "C:\\project\\.venv\\Scripts\\python.exe");
  assert.equal(plan.cwd, "C:\\project");
  assert.equal(plan.mutating, false);
});
test("MCP additions retain unique names and the original discovery/transfer schemas", async () => {
  const tools = JSON.parse(await fs.readFile("helpers/tools.json", "utf8"));
  assert.equal(new Set(tools.map((t: any) => t.name)).size, tools.length);
  for (const name of [
    "map_inspect",
    "map_inventory",
    "map_jobsPage",
    "map_transfer",
    "map_packageDiscover",
  ]) {
    const tool = tools.find((t: any) => t.name === name);
    assert(tool);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("legacy map favorites import once and preserve existing names", async () => {
  const { WorkspaceStore } = await import("../src/core/workspaces");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-favorites-import-"));
  try {
    const store = new WorkspaceStore(dir);
    const item = {
      name: "Existing",
      uri: "file:///C:/Project",
      locations: [
        {
          ref: { endpoint: "c", path: "C:\\Project" },
          endpoint: {
            id: "c",
            name: "C",
            kind: "windows" as const,
            root: "C:\\",
          },
        },
      ],
    };
    await store.save(item);
    await store.importLocation({ ...item, name: "Old bookmark" });
    await store.importLocation({ ...item, name: "Old bookmark" });
    const saved = await store.list();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, "Existing");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("windows share named SSH machines without overwriting an existing import or disconnect", async () => {
  const { MachineStore } = await import("../src/core/machines");
  const { Endpoints } = await import("../src/adapters/registry");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-machines-"));
  const first = new MachineStore(dir),
    second = new MachineStore(dir);
  const endpoints = new Endpoints(
    path.resolve("helpers/endpoint.py"),
    () => {},
  );
  try {
    await first.prepare();
    const train = {
      id: "train",
      kind: "ssh" as const,
      host: "gpu-lab",
      name: "Training",
      root: "/home/user",
    };
    const infer = {
      ...train,
      id: "infer",
      host: "serve-lab",
      name: "Inference",
    };
    await Promise.all([first.save(train, true), second.save(infer)]);
    assert.deepEqual((await second.list()).map((m) => m.id).sort(), [
      "infer",
      "train",
    ]);
    const attached = endpoints.add(train);
    await endpoints.disconnect(train.id);
    await second.save({ ...train, name: "训练机" });
    await first.save(train, true);
    const saved = (await first.list()).find((m) => m.id === "train")!;
    assert.equal(saved.name, "训练机");
    assert.equal(saved.host, train.host);
    attached.config.name = saved.name;
    assert.equal(endpoints.items.get("train"), attached);
    assert.equal(endpoints.enabled("train"), false);
  } finally {
    await endpoints.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
