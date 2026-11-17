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
