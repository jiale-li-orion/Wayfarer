import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Core } from "../src/core/core";
import { Jobs } from "../src/core/jobs";
import { Profiler } from "../src/core/log";
import { TransportLost } from "../src/core/lifecycle";
import { Bridge } from "../src/mcp/bridge";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  read: () => Promise<T> | T,
  valid: (value: T) => boolean,
  ms = 10000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await read();
    if (valid(result)) return result;
    if (Date.now() > deadline)
      throw Error("Wait expired: " + JSON.stringify(result));
    await sleep(10);
  }
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-resume-"));
  const source = path.join(root, "source"),
    target = path.join(root, "target"),
    storage = path.join(root, "state");
  await fs.mkdir(source);
  await fs.mkdir(target);
  const configs = [
    { id: "source", kind: "local" as const, name: "source", root: source },
    { id: "target", kind: "local" as const, name: "target", root: target },
  ];
  const open = async () => {
    const core = new Core(
      storage,
      path.resolve("helpers/endpoint.py"),
      new Profiler(() => {}),
    );
    await core.init(configs);
    return core;
  };
  const input = {
    mode: "move",
    conflict: "rename",
    sources: [{ endpoint: "source", path: path.join(source, "中文 file.bin") }],
    target: { endpoint: "target", path: target },
  };
  return {
    root,
    source,
    target,
    storage,
    open,
    input,
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  };
}
const done = (core: Core, id: string) =>
  until(
    () => core.jobs.get(id),
    (j) => !["queued", "running"].includes(j.state),
  );
test("operation receipt survives lost acknowledgement, concurrent retry and archived restart", async () => {
  const f = await fixture();
  let core = await f.open();
  try {
    const args = {
      ref: { endpoint: "target", path: f.target },
      name: "created once",
      operationId: "lost-ack",
    };
    const jobs = await Promise.all(
      Array.from({ length: 10 }, () => core.dispatch("mkdir", args)),
    );
    assert.equal(new Set(jobs.map((j) => j.id)).size, 1);
    assert.equal((await done(core, jobs[0].id)).state, "completed");
    await core.dispose();
    core = await f.open();
    const retry = await core.dispatch("mkdir", args);
    assert.equal(retry.id, jobs[0].id);
    assert.equal(retry.state, "completed");
    assert.equal(
      (await core.dispatch("operation", { operationId: "lost-ack" })).id,
      retry.id,
    );
    await assert.rejects(
      core.dispatch("mkdir", { ...args, name: "different" }),
      /different arguments/,
    );
    assert.deepEqual(await fs.readdir(f.target), ["created once"]);
  } finally {
    await core.dispose();
    await f.dispose();
  }
});
test("shutdown drains finally and auto-resumes verified cross-endpoint move on reopen", async () => {
  const f = await fixture();
  let core = await f.open();
  try {
    const content = Buffer.alloc(24 * 1048576, 91);
    await fs.writeFile(f.input.sources[0].path, content);
    const source = core.endpoints.get("source"),
      read = source.readInto!.bind(source);
    source.readInto = async (...args) => {
      await sleep(25);
      return read(...args);
    };
    const job = await core.dispatch("transfer", {
      ...f.input,
      operationId: "reloaded-move",
    });
    await until(
      () => core.jobs.get(job.id).bytes,
      (n) => n > 0,
    );
    await Promise.all([core.dispose(), core.dispose()]);
    assert.equal(core.jobs.get(job.id).pauseReason, "shutdown");
    assert.deepEqual(core.transfers.stats(), {
      leases: 0,
      buffers: 0,
      bufferBytes: 0,
    });
    assert.equal(core.jobs.stats().runners, 0);
    assert.equal(core.jobs.stats().heldLocks, 0);
    core = await f.open();
    assert.equal((await done(core, job.id)).state, "completed");
    assert.deepEqual(
      await fs.readFile(path.join(f.target, "中文 file.bin")),
      content,
    );
    await assert.rejects(fs.stat(f.input.sources[0].path));
    assert.equal((await fs.readdir(f.target)).length, 1);
  } finally {
    await core.dispose();
    await f.dispose();
  }
});
test("manual pause stays paused; cancellation removes only registered private partials", async () => {
  const f = await fixture();
  let core = await f.open();
  try {
    await fs.writeFile(f.input.sources[0].path, Buffer.alloc(12 * 1048576, 5));
    const source = core.endpoints.get("source"),
      read = source.readInto!.bind(source);
    source.readInto = async (...args) => {
      await sleep(30);
      return read(...args);
    };
    const job = await core.dispatch("transfer", { ...f.input, mode: "copy" });
    await until(
      () => core.jobs.get(job.id).bytes,
      (n) => n > 0,
    );
    core.jobs.control(job.id, "pause");
    await done(core, job.id);
    await core.dispose();
    core = await f.open();
    assert.equal(core.jobs.get(job.id).state, "paused");
    assert.equal(core.jobs.get(job.id).pauseReason, "user");
    const unrelated = path.join(f.target, ".workspace-map-unrelated.partial");
    await fs.writeFile(unrelated, "keep");
    core.jobs.control(job.id, "cancel");
    await done(core, job.id);
    await core.jobs.durable();
    assert.deepEqual(await fs.readdir(f.target), [
      ".workspace-map-unrelated.partial",
    ]);
    assert.equal((await fs.stat(f.input.sources[0].path)).size, 12 * 1048576);
    assert.deepEqual((await core.jobs.details(job.id)).cleanupPending, []);
  } finally {
    await core.dispose();
    await f.dispose();
  }
});
test("cleanup failure keeps ownership in terminal archive and explicit retry reclaims it", async () => {
  const f = await fixture();
  let core = await f.open();
  try {
    await fs.writeFile(f.input.sources[0].path, Buffer.alloc(12 * 1048576, 7));
    const source = core.endpoints.get("source"),
      read = source.readInto!.bind(source);
    source.readInto = async (...args) => {
      await sleep(20);
      return read(...args);
    };
    const job = await core.dispatch("transfer", { ...f.input, mode: "copy" });
    await until(
      () => core.jobs.get(job.id).bytes,
      (n) => n > 0,
    );
    core.jobs.control(job.id, "pause");
    await done(core, job.id);
    const target = core.endpoints.get("target"),
      call = target.call.bind(target);
    target.call = async (method, args) => {
      if (method === "remove") throw Error("denied fixture");
      return call(method, args);
    };
    core.jobs.control(job.id, "cancel");
    await done(core, job.id);
    await core.jobs.durable();
    assert.equal((await core.jobs.details(job.id)).cleanupPending!.length, 1);
    await core.dispose();
    core = await f.open();
    assert.equal(
      (await core.dispatch("jobCleanup", { id: job.id })).cleanupPending.length,
      0,
    );
    assert.deepEqual(await fs.readdir(f.target), []);
  } finally {
    await core.dispose();
    await f.dispose();
  }
});
test("legacy paused records remain manual; lifecycle marker resumes interrupted transfers only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-legacy-"));
  const jobs = new Jobs(root, new Profiler(() => {}));
  let runs = 0;
  jobs.register("transfer", async () => {
    runs++;
  });
  jobs.register("package", async () => {
    runs++;
  });
  try {
    const template = {
      created: 1,
      updated: 1,
      bytes: 0,
      files: 0,
      input: {},
      logs: [],
      checkpoint: {},
      state: "paused",
      kind: "transfer",
    };
    await fs.writeFile(
      path.join(root, "old.json"),
      JSON.stringify({ ...template, id: "old" }),
    );
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        ...template,
        id: "package",
        kind: "package",
        pauseReason: "shutdown",
      }),
    );
    await fs.writeFile(
      path.join(root, "modern.json"),
      JSON.stringify({
        ...template,
        id: "modern",
        state: "running",
        journalVersion: 2,
        lifecycleVersion: 1,
      }),
    );
    await fs.writeFile(path.join(root, "modern.input.json"), "{}");
    await fs.writeFile(
      path.join(root, "modern.checkpoint.jsonl"),
      JSON.stringify({ key: "locks", value: [] }) + "\n",
    );
    await jobs.init();
    jobs.resumeInterrupted();
    await until(
      () => jobs.get("modern").state,
      (state) => state === "completed",
    );
    assert.equal(runs, 1);
    assert.equal(jobs.get("old").state, "paused");
    assert.equal(jobs.get("package").state, "paused");
    jobs.control("old", "resume");
    await until(
      () => jobs.get("old").state,
      (s) => s === "completed",
    );
    assert.equal(runs, 2);
  } finally {
    await jobs.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("network interruption recovers once; source mutation remains a local failed task", async () => {
  const f = await fixture();
  const core = await f.open();
  try {
    const bytes = Buffer.alloc(8 * 1048576, 8);
    await fs.writeFile(f.input.sources[0].path, bytes);
    const source = core.endpoints.get("source"),
      read = source.readInto!.bind(source);
    let lost = false;
    source.readInto = async (...args) => {
      if (!lost) {
        lost = true;
        throw new TransportLost("fixture network loss");
      }
      return read(...args);
    };
    const job = await core.dispatch("transfer", { ...f.input, mode: "copy" });
    assert.equal((await done(core, job.id)).pauseReason, "network");
    await until(
      () => core.jobs.get(job.id).state,
      (s) => s === "completed",
    );
    assert.deepEqual(
      await fs.readFile(path.join(f.target, "中文 file.bin")),
      bytes,
    );
    await until(
      () => core.jobs.stats().runners,
      (n) => n === 0,
    );
    assert.equal(core.jobs.stats().heldLocks, 0);
  } finally {
    await core.dispose();
    await f.dispose();
  }
});
test("shutdown force releases hung runner before checkpoint flush and is idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-drain-"));
  const jobs = new Jobs(root, new Profiler(() => {}));
  let release!: () => void,
    finallyDone = false,
    forced = 0;
  jobs.register("transfer", async (c) => {
    try {
      await new Promise<void>((r) => (release = r));
      c.check();
    } finally {
      finallyDone = true;
      c.job.checkpoint.drained = true;
      await c.save();
    }
  });
  try {
    await jobs.init();
    const job = jobs.submit("transfer", {});
    await until(() => release, Boolean);
    const a = jobs.dispose(() => {
        forced++;
        release();
      }),
      b = jobs.dispose();
    assert.equal(a, b);
    await a;
    assert.equal(forced, 1);
    assert.equal(finallyDone, true);
    assert.equal(jobs.stats().running, 0);
    assert.equal(jobs.stats().runners, 0);
    assert.equal(jobs.get(job.id).checkpoint.drained, true);
  } finally {
    await jobs.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("one MCP client survives 50 rebinds and ten instance replacements with bounded resources", async () => {
  const f = await fixture();
  const oldHome = process.env.HOME;
  process.env.HOME = f.root;
  const mapId = "stable-fixture-map";
  let core = await f.open();
  let bridge = new Bridge(core, path.resolve("helpers"), "same-name", mapId);
  let otherCore = new Core(
    path.join(f.root, "other-state"),
    path.resolve("helpers/endpoint.py"),
    new Profiler(() => {}),
  );
  await otherCore.init();
  const other = new Bridge(
    otherCore,
    path.resolve("helpers"),
    "same-name",
    "other-map",
  );
  await bridge.start();
  await other.start();
  const client = spawn("python3", ["-u", "helpers/mcp.py", "--map", mapId], {
    stdio: "pipe",
    env: { ...process.env },
  });
  const responses = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  const notices: any[] = [];
  let seq = 0;
  let stderr = "";
  client.stderr.on("data", (b) => (stderr += b));
  const lines = createInterface({ input: client.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.id != null) {
      const waiting = responses.get(value.id);
      responses.delete(value.id);
      if (value.error) waiting?.reject(Error(value.error.message));
      else waiting?.resolve(value.result);
    } else if (value.params?.data) {
      notices.push(value.params.data);
      if (notices.length > 30) notices.shift();
    }
  });
  const request = (method: string, params: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      responses.set(id, { resolve, reject });
      client.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const tool = async (name: string, args: any = {}) => {
    const result = await request("tools/call", {
      name: "map_" + name,
      arguments: args,
    });
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const connected = () =>
    until(
      () => tool("connection"),
      (value) => value.state === "connected",
      5000,
    );
  try {
    await request("initialize", { protocolVersion: "2025-06-18" });
    client.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    assert.equal((await connected()).mapId, mapId);
    for (let i = 0; i < 50; i++) {
      await tool("bind", { mapId: i % 2 ? mapId : "other-map" });
      await connected();
    }
    await tool("bind", { mapId });
    await connected();
    await until(
      () => other.stats().clients,
      (n) => n === 0,
    );
    assert.equal(otherCore.directories.stats().clients, 0);
    for (let i = 0; i < 10; i++) {
      const old = bridge.id;
      bridge.stopIngress();
      await core.dispose();
      await bridge.dispose();
      core = await f.open();
      bridge = new Bridge(core, path.resolve("helpers"), "same-name", mapId);
      await bridge.start();
      const status = await connected();
      assert.equal(status.mapId, mapId);
      assert.notEqual(status.id, old);
      assert.equal(status.pendingRequests, 0);
      assert.equal(status.recoveryFlows, 1);
      assert.equal(status.waitingPoll, false);
      assert.equal(bridge.stats().clients, 1);
      assert.equal(core.directories.stats().clients, 1);
      const view = await tool("view");
      assert.equal(view.follow, false);
    }
    assert.ok(notices.some((n) => n.type === "resumed"));
    await assert.rejects(
      tool("write", {
        ref: { endpoint: "target", path: path.join(f.target, "oversized") },
        content: "x".repeat(9 * 1048576),
      }),
      /exceeds 8 MiB/,
    );
    assert.equal((await tool("connection")).pendingRequests, 0);
    await assert.rejects(fs.stat(path.join(f.target, "oversized")));
    for (const method of ["mkdir", "storageScan"]) {
      const operationId = "ack-dropped-" + method;
      const originalDispatch = core.dispatch.bind(core);
      let restart: Promise<void> | undefined;
      let acceptedId: string | undefined;
      core.dispatch = async (...params) => {
        const result = await originalDispatch(...params);
        if (params[0] === method && params[1]?.operationId === operationId) {
          acceptedId = result.id;
          const oldCore = core,
            oldBridge = bridge;
          oldBridge.stopIngress();
          restart = new Promise<void>((resolve) =>
            setTimeout(async () => {
              await oldCore.dispose();
              await oldBridge.dispose();
              core = await f.open();
              bridge = new Bridge(
                core,
                path.resolve("helpers"),
                "same-name",
                mapId,
              );
              await bridge.start();
              resolve();
            }, 0),
          );
        }
        return result;
      };
      const recovered = await tool(method, {
        ref: { endpoint: "target", path: f.target },
        operationId,
        ...(method === "mkdir" ? { name: "ack recovered" } : {}),
      });
      await restart;
      assert.equal(recovered.id, acceptedId);
      assert.equal(recovered.operationId, operationId);
      assert.equal(
        (await core.dispatch("operation", { operationId })).id,
        recovered.id,
      );
      if (method === "mkdir") {
        assert.equal(
          (
            await until(
              () => core.jobs.details(recovered.id),
              (j) => j.state === "completed",
            )
          ).state,
          "completed",
        );
        assert.equal(
          (await fs.readdir(f.target)).filter(
            (name) => name === "ack recovered",
          ).length,
          1,
        );
      } else {
        assert.equal(
          core.jobs.list().filter((j) => j.operationId === operationId).length,
          1,
        );
      }
    }
    const args = {
      ref: { endpoint: "target", path: f.target },
      name: "mcp operation",
      operationId: "client-once",
    };
    const accepted = await tool("mkdir", args);
    assert.equal((await tool("mkdir", args)).id, accepted.id);
    await done(core, accepted.id);
    client.stdin.end();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    await until(
      () => bridge.stats().clients,
      (n) => n === 0,
    );
    assert.equal(core.directories.stats().clients, 0);
    assert.equal(core.directories.stats().clientCursors, 0);
    assert.equal(stderr, "");
  } finally {
    client.kill("SIGKILL");
    lines.close();
    bridge.stopIngress();
    other.stopIngress();
    await core.dispose();
    await otherCore.dispose();
    await bridge.dispose();
    await other.dispose();
    process.env.HOME = oldHome;
    await f.dispose();
  }
});
test("client cursors are isolated and a detached client's late scan is reclaimed", async () => {
  const f = await fixture();
  const core = await f.open();
  try {
    await Promise.all(
      Array.from({ length: 225 }, (_, i) =>
        fs.writeFile(path.join(f.source, String(i)), "x"),
      ),
    );
    core.attachClient("first");
    core.attachClient("second");
    const page = await core.dispatch(
      "list",
      { ref: { endpoint: "source", path: f.source }, refresh: true },
      "agent",
      "first",
    );
    assert.ok(page.cursor);
    await assert.rejects(
      core.dispatch(
        "list",
        { ref: { endpoint: "source", path: f.source }, cursor: page.cursor },
        "agent",
        "second",
      ),
      /another client/,
    );
    core.releaseClient("first");
    await until(
      async () =>
        (await core.endpoints.get("source").call("resources")).cursors,
      (n) => n === 0,
    );
    const endpoint = core.endpoints.get("source"),
      call = endpoint.call.bind(endpoint);
    let release!: () => void;
    endpoint.call = async (method, args) => {
      if (method === "list") await new Promise<void>((r) => (release = r));
      return call(method, args);
    };
    const pending = core
      .dispatch(
        "list",
        { ref: { endpoint: "source", path: f.source }, refresh: true },
        "agent",
        "second",
      )
      .catch(() => undefined);
    await until(() => release, Boolean);
    core.releaseClient("second");
    release();
    await pending;
    assert.equal((await endpoint.call("resources")).cursors, 0);
    assert.equal(core.directories.stats().clientCursors, 0);
  } finally {
    await core.dispose();
    await f.dispose();
  }
});
test("real helper loss auto-resumes; explicit endpoint disconnect remains manual after reconnect", async () => {
  const f = await fixture();
  const core = await f.open();
  const oldPath = process.env.PATH;
  try {
    await fs.writeFile(
      path.join(f.root, "ssh"),
      '#!/bin/sh\nfor arg do last="$arg"; done\nexec /bin/sh -c "$last"\n',
      { mode: 0o700 },
    );
    process.env.PATH = f.root + path.delimiter + oldPath;
    core.endpoints.add({
      id: "remote",
      kind: "ssh",
      name: "fixture SSH",
      host: "fixture",
      root: f.target,
    });
    await fs.writeFile(f.input.sources[0].path, Buffer.alloc(24 * 1048576, 42));
    const source = core.endpoints.get("source"),
      read = source.readInto!.bind(source);
    source.readInto = async (...args) => {
      await sleep(30);
      return read(...args);
    };
    const args = {
      ...f.input,
      mode: "copy",
      target: { endpoint: "remote", path: f.target },
    };
    const job = await core.dispatch("transfer", args);
    await until(
      () => core.jobs.get(job.id).bytes,
      (n) => n > 0,
    );
    const resource = await core.endpoints.get("remote").call("resources");
    process.kill(resource.transfer.pid, "SIGKILL");
    const resumed = await until(
      () => core.jobs.get(job.id),
      (job) => ["completed", "failed"].includes(job.state),
      20000,
    );
    assert.equal(resumed.state, "completed", resumed.error);
    assert.equal(
      (await core.endpoints.get("remote").call("resources")).transferUsers,
      0,
    );
    const second = await core.dispatch("transfer", args);
    await until(
      () => core.jobs.get(second.id).bytes,
      (n) => n > 0,
    );
    await core.dispatch("endpointControl", {
      endpoint: "remote",
      action: "disconnect",
    });
    assert.equal(
      (await done(core, second.id)).pauseReason,
      "endpoint-disconnected",
    );
    await core.dispatch("endpointControl", {
      endpoint: "remote",
      action: "connect",
    });
    await sleep(100);
    assert.equal(core.jobs.get(second.id).state, "paused");
    core.jobs.control(second.id, "resume");
    assert.equal((await done(core, second.id)).state, "completed");
    assert.deepEqual(
      await fs.readFile(path.join(f.target, "中文 file (2).bin")),
      await fs.readFile(f.input.sources[0].path),
    );
  } finally {
    await core.dispose();
    process.env.PATH = oldPath;
    await f.dispose();
  }
});

test("legacy per-request MCP sockets retain pagination across requests", async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  const core = await f.open();
  const bridge = new Bridge(
    core,
    path.resolve("helpers"),
    "legacy fixture",
    "legacy-map",
  );
  try {
    await Promise.all(
      Array.from({ length: 225 }, (_, i) =>
        fs.writeFile(path.join(f.source, String(i)), "x"),
      ),
    );
    await bridge.start();
    const recordPath = path.join(
      f.root,
      ".local/share/workspace-map/sessions",
      bridge.id + ".json",
    );
    await until(
      () => fs.readFile(recordPath, "utf8").then(JSON.parse, () => undefined),
      Boolean,
    );
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    const request = (args: any) =>
      new Promise<any>((resolve, reject) => {
        const socket = net.createConnection(record.socket);
        let buffer = "";
        socket.on("error", reject);
        socket.on("connect", () =>
          socket.write(
            JSON.stringify({ id: "legacy", method: "list", args }) + "\n",
          ),
        );
        socket.on("data", (data) => {
          buffer += data;
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const message = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (message.id === "legacy") {
              socket.end();
              message.error
                ? reject(Error(message.error))
                : resolve(message.result);
            }
          }
        });
      });
    const ref = { endpoint: "source", path: f.source };
    const first = await request({ ref, refresh: true });
    assert.equal(first.entries.length, 200);
    const second = await request({ ref, cursor: first.cursor });
    assert.equal(second.entries.length, 25);
    assert.equal(second.cursor, undefined);
  } finally {
    bridge.stopIngress();
    await core.dispose();
    await bridge.dispose();
    process.env.HOME = previousHome;
    await f.dispose();
  }
});
test("interrupted package command retains its actual result across restart and receipt retry", async () => {
  const f = await fixture();
  let core = await f.open();
  try {
    const python = path.join(f.root, "fixture-python");
    await fs.writeFile(
      python,
      '#!/usr/bin/env python3\nimport time\nprint("fixture manager ready",flush=True)\ntime.sleep(60)\n',
      { mode: 0o700 },
    );
    const args = {
      endpoint: "source",
      cwd: f.source,
      manager: "pip",
      action: "list",
      python,
      operationId: "package-interrupted",
    };
    const job = await core.dispatch("package", args);
    await until(() => core.jobs.get(job.id).checkpoint.process, Boolean);
    core.jobs.control(job.id, "cancel");
    assert.equal((await done(core, job.id)).state, "cancelled");
    const original = await core.jobs.details(job.id);
    assert.equal(original.result.interrupted, true);
    assert.notEqual(original.result.exitCode, null);
    assert.equal(
      (await core.endpoints.get("source").call("resources")).processes,
      0,
    );
    await core.dispose();
    core = await f.open();
    const duplicate = await core.dispatch("package", args);
    assert.equal(duplicate.id, job.id);
    assert.equal(duplicate.state, "cancelled");
    assert.deepEqual((await core.jobs.details(job.id)).result, original.result);
    assert.equal(core.jobs.stats().running, 0);
  } finally {
    await core.dispose();
    await f.dispose();
  }
});
test("successful final commit remains completed when shutdown arrives at its acknowledgement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-committed-"));
  const jobs = new Jobs(root, new Profiler(() => {}));
  let commit!: () => void;
  jobs.register("package", async () => {
    await new Promise<void>((resolve) => (commit = resolve));
    return { exitCode: 0, committed: true };
  });
  try {
    await jobs.init();
    const task = jobs.submit("package", {});
    await until(() => commit, Boolean);
    const closing = jobs.dispose();
    commit();
    await closing;
    assert.equal(jobs.get(task.id).state, "completed");
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(
          root,
          "history",
          String(task.created).padStart(16, "0") + "-" + task.id + ".json",
        ),
        "utf8",
      ),
    );
    assert.equal(metadata.journalVersion, 2);
    assert.equal(metadata.lifecycleVersion, 1);
    assert.deepEqual((await jobs.details(task.id)).result, {
      exitCode: 0,
      committed: true,
    });
  } finally {
    await jobs.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
