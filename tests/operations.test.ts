import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EndpointConfig } from "../src/shared/types";
import type { SystemMonitor } from "../src/core/monitor";
import { OperationsStore } from "../src/core/operations";
import { compareMachines, sameConfirmedShare } from "../src/core/fleet";

const endpoints = (): EndpointConfig[] => [
  {
    id: "a",
    host: "training-a",
    kind: "ssh",
    name: "Training A",
    root: "/data",
  },
  {
    id: "b",
    host: "training-b",
    kind: "ssh",
    name: "Training B",
    root: "/data",
  },
  {
    id: "c",
    host: "inference",
    kind: "ssh",
    name: "Inference",
    root: "/home/user",
  },
];
const pair = {
  source: { endpoint: "a", address: "10.0.0.5" },
  target: { endpoint: "b", address: "10.0.0.6" },
};
async function fixture(run: (file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-operations-"));
  try {
    await run(path.join(dir, "settings.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("patrol groups and direct pair approval persist separately and follow endpoint identity", () =>
  fixture(async (file) => {
    const config = endpoints();
    const store = new OperationsStore(file, () => config);
    await store.init();
    assert.deepEqual(store.group("daily").endpoints, ["a", "b", "c"]);
    await store.saveGroup({
      id: "lab",
      name: "Lab",
      endpoints: ["a", "b"],
      confirmedShares: ["verified"],
      mounts: { a: ["/data"] },
    });
    await store.savePair(pair);
    const reopened = new OperationsStore(file, () => config);
    await reopened.init();
    assert.equal(reopened.catalog().selected, "lab");
    assert.deepEqual(reopened.group("lab").mounts.a, ["/data"]);
    assert.deepEqual(reopened.pair("b", "a"), {
      source: pair.target,
      target: pair.source,
    });
    config[0].host = "different-host";
    assert.equal(reopened.pair("a", "b"), undefined);
    assert.deepEqual(reopened.catalog().pairs, []);
    await assert.rejects(
      reopened.savePair({
        ...pair,
        target: { endpoint: "b", address: "8.8.8.8" },
      }),
      /私网/,
    );
  }));

test("confirmed NFS identity detects only matching relative files and invalidates on route changes", () =>
  fixture(async (file) => {
    const config = endpoints();
    const store = new OperationsStore(file, () => config);
    const data = {
      a: {
        path: "/data/share",
        source: "10.0.0.9:/share",
        filesystem: "nfs",
        serverAddress: "10.0.0.9",
        route: { src: "10.0.0.5", dev: "eth1" },
        available: 5,
      },
      b: {
        path: "/mnt/shared",
        source: "10.0.0.9:/share",
        filesystem: "nfs",
        serverAddress: "10.0.0.9",
        route: { src: "10.0.0.6", dev: "eth1" },
        available: 5,
      },
    };
    const sample = (endpoint: "a" | "b") => ({
      name: endpoint,
      status: "online",
      stamp: Date.now(),
      mounts: [data[endpoint]],
    });
    const monitor = {
      machines: () =>
        config.map((c) => ({
          id: c.id,
          endpoint: c.id,
          config: c,
          roots: [{ endpoint: c.id }],
        })),
      snapshot: ({ endpoint }: { endpoint: "a" | "b" }) => sample(endpoint),
      recentComparison: sample,
    } as unknown as SystemMonitor;
    const discovered = await compareMachines(monitor, ["a", "b"]);
    await store.saveGroup({
      id: "lab",
      name: "Lab",
      endpoints: ["a", "b"],
      mounts: {},
      confirmedShares: [discovered.shares[0].key],
    });
    const a = { endpoint: "a", path: "/data/share/sub/file" };
    const b = { endpoint: "b", path: "/mnt/shared/sub/file" };
    assert.equal(sameConfirmedShare(monitor, store, a, b), true);
    assert.equal(
      sameConfirmedShare(monitor, store, a, {
        ...b,
        path: "/mnt/shared/other",
      }),
      false,
    );
    data.b.route.dev = "eth0";
    assert.equal(sameConfirmedShare(monitor, store, a, b), false);
    const changed = await compareMachines(
      monitor,
      ["a", "b"],
      store.group("lab").confirmedShares,
    );
    assert.equal(changed.shares[0].confirmed, false);
  }));
