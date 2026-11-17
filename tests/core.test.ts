import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
import { alias } from "../src/shared/paths";
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-map-test-"));
  const a = path.join(dir, "A");
  const b = path.join(dir, "B");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const core = new Core(
    path.join(dir, "state"),
    path.resolve("helpers/endpoint.py"),
    new Profiler(() => {}),
  );
  await core.init([
    { id: "a", kind: "local", root: a, name: "A" },
    { id: "b", kind: "local", root: b, name: "B" },
  ]);
  return {
    dir,
    a,
    b,
    core,
    close: async () => {
      await core.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
async function finish(
  core: Core,
  id: string,
  states = ["completed", "failed", "paused", "cancelled"],
) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const j = core.jobs.get(id);
    if (states.includes(j.state)) return j;
    if (Date.now() > deadline)
      throw Error("Task timed out: " + JSON.stringify(j));
    await new Promise((r) => setTimeout(r, 10));
  }
}
test("pagination includes hidden and unicode entries; no recursive scan", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 435; i++)
      await fs.writeFile(path.join(f.a, "中文 空格 " + i), "data");
    await fs.mkdir(path.join(f.a, ".hidden"));
    await fs.writeFile(path.join(f.a, ".hidden", "nested"), "x");
    let cursor;
    const names: string[] = [];
    do {
      const p = await f.core.dispatch("list", {
        ref: { endpoint: "a", path: f.a },
        cursor,
      });
      assert(p.entries.length <= 200);
      names.push(...p.entries.map((e: any) => e.name));
      cursor = p.cursor;
    } while (cursor);
    assert.equal(names.length, 436);
    assert(names.includes(".hidden"));
    assert(!names.includes("nested"));
  } finally {
    await f.close();
  }
});
test("cross-endpoint move verifies bytes, keeps symlink identity, handles unicode", async () => {
  const f = await fixture();
  try {
    const src = path.join(f.a, "目录 空格");
    await fs.mkdir(src);
    await fs.writeFile(
      path.join(src, "data.bin"),
      Buffer.alloc(7 * 1048576, 73),
    );
    await fs.symlink("data.bin", path.join(src, "link"));
    const j = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: src }],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "rename",
    });
    const result = await finish(f.core, j.id);
    assert.equal(result.state, "completed", result.error);
    assert.equal(
      (await fs.readFile(path.join(f.b, "目录 空格/data.bin"))).length,
      7 * 1048576,
    );
    assert.equal(
      await fs.readlink(path.join(f.b, "目录 空格/link")),
      "data.bin",
    );
    await assert.rejects(fs.stat(src));
  } finally {
    await f.close();
  }
});
test("copy-to-child and same source/target are rejected with source intact", async () => {
  const f = await fixture();
  try {
    const src = path.join(f.a, "folder");
    await fs.mkdir(src);
    const child = path.join(src, "child");
    await fs.mkdir(child);
    await fs.writeFile(path.join(src, "x"), "safe");
    const j = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: src }],
      target: { endpoint: "a", path: child },
      mode: "move",
      conflict: "rename",
    });
    assert.equal((await finish(f.core, j.id)).state, "failed");
    assert.equal(await fs.readFile(path.join(src, "x"), "utf8"), "safe");
    const k = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: path.join(src, "x") }],
      target: { endpoint: "a", path: src },
      mode: "copy",
      conflict: "overwrite",
    });
    assert.equal((await finish(f.core, k.id)).state, "failed");
  } finally {
    await f.close();
  }
});
test("explicit collision policies skip, rename and overwrite", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.a, "x"), "new");
    await fs.writeFile(path.join(f.b, "x"), "old");
    for (const conflict of ["skip", "rename", "overwrite"]) {
      const j = await f.core.dispatch("transfer", {
        sources: [{ endpoint: "a", path: path.join(f.a, "x") }],
        target: { endpoint: "b", path: f.b },
        mode: "copy",
        conflict,
      });
      assert.equal((await finish(f.core, j.id)).state, "completed");
    }
    assert.equal(await fs.readFile(path.join(f.b, "x (2)"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(f.b, "x"), "utf8"), "new");
  } finally {
    await f.close();
  }
});
test("pause releases scheduler and resumes a verified partial; source change retains source", async () => {
  const f = await fixture();
  try {
    const src = path.join(f.a, "large");
    await fs.writeFile(src, Buffer.alloc(16 * 1048576, 91));
    const e = f.core.endpoints.get("b");
    const write = e.writeBuffer!.bind(e);
    e.writeBuffer = async (...args) => {
      await new Promise((r) => setTimeout(r, 25));
      return write(...args);
    };
    const input = {
      sources: [{ endpoint: "a", path: src }],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "rename",
    };
    const j = await f.core.dispatch("transfer", input);
    setTimeout(() => f.core.jobs.control(j.id, "pause"), 40);
    assert.equal((await finish(f.core, j.id)).state, "paused");
    assert(await fs.stat(src));
    f.core.jobs.control(j.id, "resume");
    const done = await finish(f.core, j.id);
    assert.equal(done.state, "completed", done.error);
    await fs.writeFile(src, Buffer.alloc(16 * 1048576, 43));
    const k = await f.core.dispatch("transfer", input);
    setTimeout(() => f.core.jobs.control(k.id, "pause"), 40);
    await finish(f.core, k.id);
    await fs.appendFile(src, "changed");
    f.core.jobs.control(k.id, "resume");
    const bad = await finish(f.core, k.id);
    assert.equal(bad.state, "failed");
    assert.match(bad.error!, /changed/);
    assert(await fs.stat(src));
  } finally {
    await f.close();
  }
});
test("Windows and WSL drive aliases resolve to the same comparison identity", () => {
  assert.equal(
    alias(
      { id: "win", name: "win", kind: "windows", root: "C:\\" },
      "C:\\Users\\Name",
    ),
    alias(
      { id: "wsl", name: "wsl", kind: "wsl", root: "/" },
      "/mnt/c/Users/Name",
    ),
  );
});
test("Agent focus obeys follow toggle; manual navigation exits follow", async () => {
  const f = await fixture();
  try {
    const ref = { endpoint: "a", path: f.a };
    await f.core.dispatch("navigate", { ref }, "agent");
    assert.equal(f.core.view.root, undefined);
    assert.deepEqual(f.core.view.agent, ref);
    await f.core.dispatch("setView", { follow: true });
    await f.core.dispatch("navigate", { ref }, "agent");
    assert.deepEqual(f.core.view.root, ref);
    await f.core.dispatch("navigate", {}, "user");
    assert.equal(f.core.view.follow, false);
  } finally {
    await f.close();
  }
});

test("paused transfer survives core restart and restores the view", async () => {
  const f = await fixture();
  let second: Core | undefined;
  try {
    const source = path.join(f.a, "restart.bin");
    await fs.writeFile(source, Buffer.alloc(24 * 1048576, 9));
    const endpoint = f.core.endpoints.get("b");
    const write = endpoint.writeBuffer!.bind(endpoint);
    endpoint.writeBuffer = async (...args) => {
      await new Promise((r) => setTimeout(r, 25));
      return write(...args);
    };
    const job = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: source }],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "rename",
    });
    setTimeout(() => f.core.jobs.control(job.id, "pause"), 40);
    assert.equal((await finish(f.core, job.id)).state, "paused");
    await f.core.dispatch("setView", {
      viewport: { x: 123, y: 456, zoom: 0.8 },
    });
    await f.core.dispose();
    second = new Core(
      path.join(f.dir, "state"),
      path.resolve("helpers/endpoint.py"),
      new Profiler(() => {}),
    );
    await second.init([
      { id: "a", kind: "local", root: f.a, name: "A" },
      { id: "b", kind: "local", root: f.b, name: "B" },
    ]);
    assert.deepEqual(second.view.viewport, { x: 123, y: 456, zoom: 0.8 });
    assert.equal(second.jobs.get(job.id).state, "paused");
    second.jobs.control(job.id, "resume");
    const done = await finish(second, job.id);
    assert.equal(done.state, "completed", done.error);
    assert.equal(
      (await fs.stat(path.join(f.b, "restart.bin"))).size,
      24 * 1048576,
    );
    await assert.rejects(fs.stat(source));
  } finally {
    await second?.dispose();
    await f.close();
  }
});
test("permission failure retains source and unrelated browsing remains available", async () => {
  if (process.getuid?.() === 0 || process.platform === "win32") return;
  const f = await fixture();
  try {
    const source = path.join(f.a, "protected.txt");
    await fs.writeFile(source, "keep");
    await fs.chmod(f.b, 0o500);
    const job = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: source }],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "rename",
    });
    assert.equal((await finish(f.core, job.id)).state, "failed");
    assert.equal(await fs.readFile(source, "utf8"), "keep");
    assert.equal(
      (await f.core.dispatch("list", { ref: { endpoint: "a", path: f.a } }))
        .entries.length,
      1,
    );
  } finally {
    await fs.chmod(f.b, 0o700);
    await f.close();
  }
});

test("dsh profile update preserves unrelated plugins, comments and existing policy", async () => {
  const f = await fixture();
  try {
    const { connectDsh } = await import("../src/mcp/integrations");
    const { parse } = await import("yaml");
    const profile = path.join(f.a, "cordis.yml");
    const content =
      "# keep this comment\n- id: other\n  name: existing-plugin\n  config:\n    policy: manual\n- id: mcp-workspace-map\n  name: old\n  config:\n    toolCallTimeoutMs: 45678\n";
    await fs.writeFile(profile, content);
    const bridge = {
      connections: [{ endpoint: "a" }],
      config: () => ({
        command: "python3",
        args: ["mcp.py", "--session", "test"],
      }),
    } as any;
    await connectDsh(f.core, bridge, "a", profile);
    const output = await fs.readFile(profile, "utf8");
    assert.match(output, /# keep this comment/);
    const entries = parse(output);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].config.policy, "manual");
    assert.equal(entries[1].config.toolCallTimeoutMs, 45678);
    assert.equal(entries[1].config.serverName, "workspace_map");
    await connectDsh(f.core, bridge, "a", profile);
    assert.equal(parse(await fs.readFile(profile, "utf8")).length, 2);
  } finally {
    await f.close();
  }
});

test("resume never deletes source if committed destination was removed while paused", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.a, "committed.txt");
    await fs.writeFile(source, "keep source");
    const dst = f.core.endpoints.get("b"),
      call = dst.call.bind(dst);
    let id = "";
    dst.call = async (method, args) => {
      const result = await call(method, args);
      if (method === "rename" && String(args?.path).endsWith(".partial"))
        f.core.jobs.control(id, "pause");
      return result;
    };
    const job = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: source }],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "rename",
    });
    id = job.id;
    assert.equal((await finish(f.core, id)).state, "paused");
    await fs.unlink(path.join(f.b, "committed.txt"));
    f.core.jobs.control(id, "resume");
    assert.equal((await finish(f.core, id)).state, "failed");
    assert.equal(await fs.readFile(source, "utf8"), "keep source");
  } finally {
    await f.close();
  }
});

test("UI and Agent use independent pages; repeated cursor returns the same page", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 450; i++)
      await fs.writeFile(path.join(f.a, "item-" + i), "data");
    const ref = { endpoint: "a", path: f.a };
    const user = await f.core.dispatch("list", { ref });
    const agent = await f.core.dispatch("list", { ref }, "agent");
    assert.notEqual(user.cursor, agent.cursor);
    const [userNext, repeated] = await Promise.all([
      f.core.dispatch("list", { ref, cursor: user.cursor }),
      f.core.dispatch("list", { ref, cursor: user.cursor }),
    ]);
    assert.deepEqual(userNext.entries, repeated.entries);
    const agentNext = await f.core.dispatch(
      "list",
      { ref, cursor: agent.cursor },
      "agent",
    );
    assert.deepEqual(userNext.entries, agentNext.entries);
    f.core.directories.watch([]);
    const tail = await f.core.dispatch(
      "list",
      { ref, cursor: agentNext.cursor },
      "agent",
    );
    assert.equal(tail.entries.length, 50);
  } finally {
    await f.close();
  }
});

test("directory overwrite merges children and preserves unrelated destination files", async () => {
  const f = await fixture();
  try {
    const a = path.join(f.a, "project"),
      b = path.join(f.b, "project");
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.writeFile(path.join(a, "replace.txt"), "new");
    await fs.writeFile(path.join(b, "replace.txt"), "old");
    await fs.writeFile(path.join(b, "keep.txt"), "keep");
    await fs.symlink("missing-target", path.join(a, "dangling"));
    await fs.symlink("old-target", path.join(b, "dangling"));
    const j = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: a }],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "overwrite",
    });
    const done = await finish(f.core, j.id);
    assert.equal(done.state, "completed", done.error);
    assert.equal(await fs.readFile(path.join(b, "replace.txt"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(b, "keep.txt"), "utf8"), "keep");
    assert.equal(await fs.readlink(path.join(b, "dangling")), "missing-target");
    await assert.rejects(fs.stat(a));
  } finally {
    await f.close();
  }
});
test("following an Agent file locates its parent and records the visible navigation history", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.a, "focus.txt");
    await fs.writeFile(file, "focus");
    await f.core.dispatch("setView", { follow: true });
    await f.core.dispatch(
      "navigate",
      { ref: { endpoint: "a", path: file } },
      "agent",
    );
    assert.deepEqual(f.core.view.root, { endpoint: "a", path: f.a });
    assert.equal(f.core.view.agent?.path, file);
    await f.core.dispatch("navigate", { ref: { endpoint: "b", path: f.b } });
    assert.deepEqual(
      (await f.core.dispatch("history", { direction: -1 })).root,
      { endpoint: "a", path: f.a },
    );
  } finally {
    await f.close();
  }
});

test("multi-select collapses descendants and duplicate physical endpoint aliases", async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.a, "folder"),
      file = path.join(dir, "child");
    await fs.mkdir(dir);
    await fs.writeFile(file, "one move");
    const j = await f.core.dispatch("transfer", {
      sources: [
        { endpoint: "a", path: file },
        { endpoint: "a", path: dir },
        { endpoint: "b", path: dir },
      ],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "rename",
    });
    assert.equal(j.input.sources.length, 1);
    const done = await finish(f.core, j.id);
    assert.equal(done.state, "completed", done.error);
    assert.equal(
      await fs.readFile(path.join(f.b, "folder", "child"), "utf8"),
      "one move",
    );
  } finally {
    await f.close();
  }
});
test("completed result payload is loaded on demand and search result pages stay bounded", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 230; i++)
      await fs.writeFile(path.join(f.a, "match-" + i), "x");
    const j = await f.core.dispatch("search", {
      ref: { endpoint: "a", path: f.a },
      query: "match",
    });
    assert.equal((await finish(f.core, j.id)).state, "completed");
    // The public details request waits for the durable result write before returning.
    const first = await f.core.dispatch("job", { id: j.id, limit: 100 });
    assert.equal(f.core.jobs.get(j.id).result, undefined);
    assert.equal(first.result.entries.length, 100);
    assert.equal(first.result.total, 230);
    assert(first.result.hasMore);
    const last = await f.core.dispatch("job", {
      id: j.id,
      offset: 200,
      limit: 100,
    });
    assert.equal(last.result.entries.length, 30);
    assert(!last.result.hasMore);
  } finally {
    await f.close();
  }
});

test("canvas path controls retain Windows drive, UNC and POSIX filename semantics", async () => {
  const { parentPath, breadcrumbsFor } =
    await import("../src/shared/displayPaths");
  assert.equal(parentPath("C:\\Users\\name.txt", true), "C:\\Users");
  assert.equal(
    parentPath("\\\\server\\share\\file", true),
    "\\\\server\\share\\",
  );
  assert.equal(parentPath("/tmp/a\\b", false), "/tmp");
  assert.deepEqual(
    breadcrumbsFor("/tmp/a\\b", false).map((p) => p.label),
    ["/", "tmp", "a\\b"],
  );
});

test("late directory reply releases its cursor after collapse; hidden map keeps editor watchers", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 205; n++)
      await fs.writeFile(path.join(f.a, `item-${n}`), "x");
    const endpoint = f.core.endpoints.get("a"),
      original = endpoint.call.bind(endpoint);
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      response = new Promise<void>((r) => (arrived = r));
    endpoint.call = async (method, args) => {
      const result = await original(method, args);
      if (method === "list") {
        arrived();
        await gate;
      }
      return result;
    };
    const ref = { endpoint: "a", path: f.a };
    f.core.directories.watch([ref]);
    const read = f.core.directories.list(ref, undefined, true);
    await response;
    f.core.directories.watch([]);
    release();
    const page = await read;
    assert.equal(page.entries.length, 200);
    assert.equal(page.cursor, undefined);
    assert.equal((await original("resources")).cursors, 0);
    endpoint.call = original;
    const releaseEditor = f.core.directories.retain(ref);
    f.core.directories.watch([ref]);
    f.core.directories.setVisible(false);
    f.core.directories.watch([{ endpoint: "b", path: f.b }]);
    assert.equal(f.core.directories.stats().watches, 1);
    assert.equal(f.core.directories.stats().editorWatches, 1);
    releaseEditor();
    assert.equal(f.core.directories.stats().watches, 0);
    f.core.directories.setVisible(true);
    assert.equal(f.core.directories.stats().watches, 1);
  } finally {
    await f.close();
  }
});

test("file bursts invalidate cached data immediately and notify each branch once", async () => {
  const f = await fixture();
  try {
    const ref = { endpoint: "a", path: f.a };
    await f.core.directories.list(ref);
    let changes = 0;
    f.core.directories.on("change", () => changes++);
    for (let i = 0; i < 600; i++) f.core.directories.invalidate(ref);
    await fs.writeFile(path.join(f.a, "new.txt"), "new");
    const fresh = await f.core.directories.list(ref);
    assert.equal(fresh.entries[0].name, "new.txt");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(changes, 1);
    f.core.directories.invalidate(ref);
    f.core.directories.dispose();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(changes, 1);
    assert.equal(f.core.directories.stats().cachedEntries, 0);
  } finally {
    await f.close();
  }
});

test("fixed distinct targets share a directory concurrently; same target and auto-rename remain serialized", async () => {
  const f = await fixture();
  const endpoint = f.core.endpoints.get("b"),
    original = endpoint.call.bind(endpoint);
  let release!: () => void;
  try {
    for (const file of ["one", "two"])
      await fs.writeFile(path.join(f.a, file), file.repeat(1024));
    for (const [conflict, names, expected] of [
      ["overwrite", ["one", "two"], 2],
      ["overwrite", ["one", "one"], 1],
      ["rename", ["one", "two"], 1],
    ] as const) {
      const gate = new Promise<void>((r) => (release = r));
      endpoint.call = async (method, args) => {
        if (method === "stat" && args?.path === f.b) await gate;
        return original(method, args);
      };
      const jobs = await Promise.all(
        names.map((name) =>
          f.core.dispatch("transfer", {
            sources: [{ endpoint: "a", path: path.join(f.a, name) }],
            target: { endpoint: "b", path: f.b },
            mode: "copy",
            conflict,
          }),
        ),
      );
      for (
        let n = 0;
        n < 100 && jobs.filter((j) => j.state === "running").length < expected;
        n++
      )
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(jobs.filter((j) => j.state === "running").length, expected);
      release();
      for (const j of jobs)
        assert.equal((await finish(f.core, j.id)).state, "completed");
      assert.equal(
        await fs.readFile(path.join(f.b, "one"), "utf8"),
        "one".repeat(1024),
      );
      assert.equal(
        await fs.readFile(path.join(f.b, "two"), "utf8"),
        "two".repeat(1024),
      );
    }
  } finally {
    release?.();
    endpoint.call = original;
    await f.close();
  }
});

test("current dsh bundle patch inserts one MCP plugin and preserves unrelated overlays", async () => {
  const f = await fixture();
  try {
    const { connectDsh } = await import("../src/mcp/integrations");
    const { parse } = await import("yaml");
    const file = path.join(f.a, "cordis.patch.yml");
    await fs.writeFile(
      file,
      "# user policy\n- id: permissions\n  config:\n    mode: ask\n- insert:\n    - id: unrelated\n      name: example\n",
    );
    const bridge: any = {
      connections: [{ endpoint: "a" }],
      config: () => ({
        command: "python3",
        args: ["mcp.py", "--session", "first"],
      }),
    };
    await connectDsh(f.core, bridge, "a", file);
    bridge.config = () => ({
      command: "python3",
      args: ["mcp.py", "--session", "second"],
    });
    await connectDsh(f.core, bridge, "a", file);
    const raw = await fs.readFile(file, "utf8"),
      rows = parse(raw);
    const plugins = rows.flatMap((r: any) => r.insert ?? []);
    assert.equal(
      plugins.filter((p: any) => p.id === "mcp-workspace-map").length,
      1,
    );
    assert.equal(
      plugins.find((p: any) => p.id === "mcp-workspace-map").config.args.at(-1),
      "second",
    );
    assert.equal(rows[0].config.mode, "ask");
    assert.ok(plugins.find((p: any) => p.id === "unrelated"));
    assert.ok(raw.includes("# user policy"));
  } finally {
    await f.close();
  }
});

test("canvas retention bounds empty and failed off-screen directories while preserving visible pages", async () => {
  const { trimBranches } = await import("../src/ui/branchCache");
  let pages: any = {};
  for (let n = 0; n < 1000; n++)
    pages = trimBranches(
      {
        ...pages,
        [String(n)]: {
          entries: [],
          stamp: n,
          error: n % 2 ? "offline" : undefined,
        },
      },
      String(n),
      new Set(["0"]),
    );
  assert.equal(Object.keys(pages).length, 128);
  assert.ok(pages["0"]);
  assert.ok(pages["999"]);
  assert.equal(pages["1"], undefined);
});

test("subscribing a branch during its first page preserves the live pagination cursor", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 205; n++)
      await fs.writeFile(path.join(f.a, String(n)), "x");
    const endpoint = f.core.endpoints.get("a"),
      original = endpoint.call.bind(endpoint);
    let release!: () => void, arrived!: () => void;
    const response = new Promise<void>((r) => (arrived = r)),
      gate = new Promise<void>((r) => (release = r));
    endpoint.call = async (method, args) => {
      const result = await original(method, args);
      if (method === "list") {
        arrived();
        await gate;
      }
      return result;
    };
    const ref = { endpoint: "a", path: f.a },
      read = f.core.directories.list(ref, undefined, true);
    await response;
    f.core.directories.watch([ref]);
    release();
    const page = await read;
    assert.ok(page.cursor);
    endpoint.call = original;
    const next = await f.core.directories.list(ref, page.cursor);
    assert.equal(next.entries.length, 5);
  } finally {
    await f.close();
  }
});

test("transfer scopes release after completion, failure and cancellation", async () => {
  const f = await fixture();
  let leases = 0;
  const endpoint = f.core.endpoints.get("b"),
    original = endpoint.call.bind(endpoint);
  endpoint.openTransfer = () => {
    leases++;
    return {
      endpoint,
      release() {
        leases--;
      },
    };
  };
  let release: (() => void) | undefined;
  try {
    const source = path.join(f.a, "payload");
    await fs.writeFile(source, Buffer.alloc(1048576, 71));
    const submit = (p: string) =>
      f.core.dispatch("transfer", {
        sources: [{ endpoint: "a", path: p }],
        target: { endpoint: "b", path: f.b },
        mode: "copy",
        conflict: "overwrite",
      });
    assert.equal(
      (await finish(f.core, (await submit(source)).id)).state,
      "completed",
    );
    assert.equal(leases, 0);
    assert.equal(
      (await finish(f.core, (await submit(path.join(f.a, "missing"))).id))
        .state,
      "failed",
    );
    assert.equal(leases, 0);
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r)),
      gate = new Promise<void>((r) => (release = r));
    endpoint.call = async (method, args) => {
      if (method === "stat" && args?.path === f.b) {
        reached();
        await gate;
      }
      return original(method, args);
    };
    const job = await submit(source);
    await entered;
    f.core.jobs.control(job.id, "cancel");
    release!();
    assert.equal((await finish(f.core, job.id)).state, "cancelled");
    assert.equal(leases, 0);
    assert.equal((await fs.stat(source)).size, 1048576);
  } finally {
    release?.();
    endpoint.call = original;
    await f.close();
  }
});

test("bounded small-file batches preserve distinct bytes across pause and resume", async () => {
  const f = await fixture();
  const source = path.join(f.a, "batch"),
    target = path.join(f.b, "batch");
  await fs.mkdir(source);
  const expected = new Map<string, Buffer>();
  for (let n = 0; n < 24; n++) {
    const bytes = Buffer.alloc([0, 1, 1023, 65537, 262144][n % 5], n + 11);
    expected.set(`file-${n}`, bytes);
    await fs.writeFile(path.join(source, `file-${n}`), bytes);
  }
  const endpoint = f.core.endpoints.get("b"),
    write = endpoint.writeBuffer!.bind(endpoint);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (reached = r));
  endpoint.writeBuffer = async (...args) => {
    reached();
    await gate;
    return write(...args);
  };
  try {
    const job = await f.core.dispatch("transfer", {
      sources: [{ endpoint: "a", path: source }],
      target: { endpoint: "b", path: f.b },
      mode: "move",
      conflict: "overwrite",
    });
    await entered;
    f.core.jobs.control(job.id, "pause");
    release();
    assert.equal((await finish(f.core, job.id)).state, "paused");
    endpoint.writeBuffer = write;
    f.core.jobs.control(job.id, "resume");
    assert.equal((await finish(f.core, job.id)).state, "completed");
    assert.equal(
      await fs.stat(source).then(
        () => true,
        () => false,
      ),
      false,
    );
    for (const [name, bytes] of expected)
      assert.deepEqual(await fs.readFile(path.join(target, name)), bytes);
  } finally {
    release?.();
    endpoint.writeBuffer = write;
    await f.close();
  }
});

test("dsh discovery selects current patch files and excludes dependency directories", async () => {
  const f = await fixture();
  const endpoint = f.core.endpoints.get("a"),
    original = endpoint.call.bind(endpoint);
  try {
    const profiles = path.join(f.dir, ".dsh/profiles");
    for (const name of ["current", "legacy", "node_modules"])
      await fs.mkdir(path.join(profiles, name), { recursive: true });
    await fs.writeFile(
      path.join(profiles, "current/package.json"),
      JSON.stringify({ dsh: { profile: { bundles: ["example"] } } }),
    );
    await fs.writeFile(path.join(profiles, "legacy/cordis.yml"), "[]\n");
    endpoint.call = (async (method: string, args?: Record<string, any>) =>
      method === "info"
        ? { home: f.dir }
        : method === "which"
          ? "/fixture/dsh"
          : original(method, args)) as typeof endpoint.call;
    const { dshProfiles } = await import("../src/mcp/integrations");
    const result = await dshProfiles(f.core, "a");
    assert.deepEqual(result.profiles.map((p) => p.name).sort(), [
      "current",
      "legacy",
    ]);
    assert.equal(
      result.profiles.find((p) => p.name === "current")?.path,
      path.join(profiles, "current/cordis.patch.yml"),
    );
  } finally {
    endpoint.call = original;
    await f.close();
  }
});
