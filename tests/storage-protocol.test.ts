import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteEndpoint } from "../src/adapters/remote";
test("malformed helper output rejects pending requests and releases its process", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-protocol-"));
  const file = path.join(dir, "helper.py");
  await fs.writeFile(
    file,
    "import sys,time\nprint('not-json');sys.stdout.flush();time.sleep(30)\n",
  );
  const e = new RemoteEndpoint(
    {
      id: "fixture",
      kind: "local",
      name: "Fixture",
      root: dir,
      python:
        process.env.WM_TEST_PYTHON ??
        (process.platform === "win32" ? "python" : "python3"),
    },
    file,
  );
  try {
    await assert.rejects(e.call("probe"), /malformed protocol/);
    assert.equal(e.connected, false);
    assert.equal(e.transportStats().pending, 0);
  } finally {
    await e.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
