import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RemoteEndpoint } from "../src/adapters/remote";

test("transfer channel shares a task lease, remains independent of browsing and exits after last release", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-map-lane-"));
  const oldPath = process.env.PATH;
  const ssh = path.join(root, "ssh");
  await fs.writeFile(
    ssh,
    '#!/bin/sh\nfor arg do last="$arg"; done\nexec /bin/sh -c "$last"\n',
    { mode: 0o700 },
  );
  process.env.PATH = root + path.delimiter + oldPath;
  const e = new RemoteEndpoint(
    {
      id: "fake-ssh",
      kind: "ssh",
      name: "Helper lifecycle fixture",
      host: "fixture",
      root,
    },
    path.resolve("helpers/endpoint.py"),
  );
  let bulkPid: number | undefined;
  try {
    const one = e.openTransfer(),
      two = e.openTransfer();
    assert.equal(one.endpoint, two.endpoint);
    const control = await e.call("info"),
      bulk = await one.endpoint.call("info");
    bulkPid = bulk.pid;
    assert.notEqual(control.pid, bulk.pid);
    const resource = await e.call("resources");
    assert.equal(resource.transferUsers, 2);
    assert.equal(resource.transfer.pid, bulk.pid);
    assert.ok(resource.transfer.rss > 0);
    const process = await one.endpoint.call("execStart", {
      argv: ["python3", "-c", "import time;time.sleep(60)"],
      cwd: root,
    });
    one.release();
    one.release();
    assert.equal((await e.call("resources")).transferUsers, 1);
    assert.equal((await e.call("list", { path: root })).entries.length, 1);
    two.release();
    const after = await e.call("resources");
    assert.equal(after.transferUsers, 0);
    assert.equal(after.transfer, undefined);
    assert.ok(after.lastTransferTransport.calls > 0);
    for (let n = 0; n < 100; n++) {
      if (
        !(await fs.stat("/proc/" + bulk.pid).then(
          () => true,
          () => false,
        ))
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(
      await fs.stat("/proc/" + bulk.pid).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await fs.stat("/proc/" + process.pid).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal((await e.call("info")).pid, control.pid);
    const next = e.openTransfer();
    assert.notEqual((await next.endpoint.call("info")).pid, bulkPid);
    next.release();
  } finally {
    e.dispose();
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
