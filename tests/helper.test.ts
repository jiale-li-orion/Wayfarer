import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("Python helper protocol handles paging, binary chunks, resources, command cancellation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-map-helper-"));
  const c = spawn("python3", ["-u", "helpers/endpoint.py"], { stdio: "pipe" });
  let seq = 0;
  const pending = new Map<number, any>();
  const lines = createInterface({ input: c.stdout });
  lines.on("line", (s) => {
    const m = JSON.parse(s);
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(m.error) : p.resolve(m.result);
  });
  const call = (method: string, args: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      c.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    });
  try {
    for (let i = 0; i < 230; i++)
      await fs.writeFile(path.join(dir, "测试 " + i), String(i));
    let p = await call("list", { path: dir, limit: 200 });
    assert.equal(p.entries.length, 200);
    p = await call("list", { path: dir, cursor: p.cursor, limit: 200 });
    assert.equal(p.entries.length, 30);
    assert.equal(p.cursor, undefined);
    const file = path.join(dir, "binary");
    await call("write", {
      path: file,
      data: Buffer.alloc(1048576, 231).toString("base64"),
      exclusive: true,
    });
    assert.equal(
      Buffer.from(await call("read", { path: file }), "base64").length,
      1048576,
    );
    const resource = await call("resources");
    assert(resource.rss > 0);
    assert.equal(resource.cursors, 0);
    const watchSupported = await call("watchSet", { paths: [dir] });
    await fs.appendFile(file, "changed");
    if (watchSupported) {
      const event = await call("watchPoll");
      assert(event.paths.includes(file));
    }
    await call("watchSet", { paths: [] });
    const reader = await call("execStart", {
      argv: ["python3", "-c", "import sys;print(len(sys.stdin.read()))"],
      cwd: dir,
    });
    let readResult: any;
    do {
      await new Promise((r) => setTimeout(r, 10));
      readResult = await call("execPoll", { id: reader.id });
    } while (readResult.code === null);
    assert.match(readResult.output, /0/);
    const proc = await call("execStart", {
      argv: [
        "python3",
        "-c",
        'import time;print("ready",flush=True);time.sleep(20)',
      ],
      cwd: dir,
    });
    await new Promise((r) => setTimeout(r, 50));
    const first = await call("execPoll", { id: proc.id });
    assert.match(first.output, /ready/);
    await call("execCancel", { id: proc.id });
  } finally {
    c.stdin.end();
    await new Promise((r) => c.once("exit", r));
    lines.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
