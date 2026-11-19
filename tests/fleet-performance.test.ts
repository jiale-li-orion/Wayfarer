import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SystemMonitor } from "../src/core/monitor";
import type { Endpoints } from "../src/adapters/registry";
import { compareMachines } from "../src/core/fleet";
import { parseRunProfile, RunProfiles } from "../src/core/runProfiles";
import { TransferTiming } from "../src/core/transferTiming";

test("compare aggregates an explicitly confirmed NFS export and preserves stale machine state", async () => {
  const monitor = {
    machines: () =>
      ["first", "second"].map((endpoint) => ({
        id: endpoint,
        endpoint,
        roots: [{ endpoint }],
      })),
    snapshot: ({ endpoint }: { endpoint: string }) => ({
      name: endpoint,
      status: endpoint === "first" ? "online" : "offline",
      stamp: endpoint === "first" ? 1 : 2,
      gpus: [{ id: "a", memoryUsed: 2, memoryTotal: 10 }],
      mounts: [
        {
          path: "/data",
          source: "/dev/nvme1n1",
          filesystem: "xfs",
          available: 5,
          total: 10,
        },
        {
          path: "/data/share",
          source: "10.0.0.202:/share",
          filesystem: "nfs",
          available: 3,
          total: 10,
        },
      ],
    }),
  } as unknown as SystemMonitor;
  const endpoints = ["first", "second"];
  const candidates = await compareMachines(monitor, endpoints);
  assert.equal(candidates.machines[1].status, "offline");
  assert.equal(candidates.shares.length, 1);
  assert.equal(candidates.shares[0].confirmed, false);
  assert.equal(candidates.shares[0].sample, undefined);
  const result = await compareMachines(monitor, endpoints, [
    candidates.shares[0].key,
  ]);
  assert.equal(result.shares[0].sample?.endpoint, "first");
  assert.equal(result.shares[0].sample?.volume.available, 3);
  assert.equal(
    result.machines.filter((m) => m.volumes.some((v) => v.path === "/data"))
      .length,
    2,
  );
});

const fixture = () => ({
  version: 1,
  runId: "run-a",
  project: "fixture",
  label: "NFS 直读",
  commit: "commit-id",
  dataset: "dataset-id",
  samples: 4,
  durationMs: 2000,
  nodes: [
    {
      endpoint: "first",
      label: "训练机 1",
      stages: [
        { kind: "wait", offsetMs: 0, durationMs: 140 },
        { kind: "compute", offsetMs: 140, durationMs: 660 },
        { kind: "compute", offsetMs: 180, durationMs: 100 },
      ],
    },
    {
      endpoint: "second",
      label: "训练机 2",
      stages: [{ kind: "communication", offsetMs: 950, durationMs: 60 }],
    },
  ],
});

test("run profiles page phases, sum each node's overlap once and index references only", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "wm-run-profile-"));
  const file = JSON.stringify(fixture());
  const store = new RunProfiles(
    {
      get: () => ({
        config: { id: "first", kind: "ssh" },
        async call(method: string) {
          return method === "stat"
            ? { kind: "file", size: Buffer.byteLength(file) }
            : Buffer.from(file).toString("base64");
        },
      }),
      configs: () => [],
    } as unknown as Endpoints,
    tmp,
  );
  try {
    const ref = { endpoint: "first", path: "/report.json" };
    const first = await store.read({ ref, remember: true, limit: 3 });
    const last = await store.read({ ref, offset: first.next });
    assert.equal(first.phaseTotals.compute, 660);
    assert.equal(first.phaseTotals.communication, 60);
    assert.equal(first.nodes[0].stageCount, 3);
    assert.equal(first.next, 3);
    assert.equal(last.stages[0].endpoint, "second");
    assert.equal(last.next, undefined);
    assert.deepEqual(await store.list(), [
      { ref, runId: "run-a", project: "fixture", label: "NFS 直读" },
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("rejects invalid stage durations and cross-endpoint log references", () => {
  const corrupt = fixture();
  corrupt.nodes[0].stages[0].durationMs = -3;
  assert.throws(() => parseRunProfile(JSON.stringify(corrupt)), /阶段/);
  const invalid = fixture();
  Object.assign(invalid.nodes[0], {
    log: { endpoint: "second", path: "/log" },
  });
  assert.throws(() => parseRunProfile(JSON.stringify(invalid)), /原始日志/);
});

test("transfer span overlap is visible and bounded across resumed segments", async () => {
  const first = new TransferTiming();
  const read1 = first.start("read");
  const read2 = first.start("read");
  const write = first.start("write");
  read2();
  read1();
  write();
  const recorded = first.finish();
  assert.equal(recorded.spans.filter((s) => s.phase === "read").length, 1);
  assert.ok(
    recorded.spans[1].startMs <=
      recorded.spans[0].startMs + recorded.spans[0].durationMs,
  );
  const resume = new TransferTiming();
  for (let i = 0; i < 120; i++) resume.start("verify")();
  const complete = resume.finish(recorded);
  assert.ok(complete.clipped);
  assert.equal(complete.spans.length, 96);
  assert.ok(complete.spans.every((s) => s.startMs >= recorded.executionMs));
  assert.equal(complete.totals.read, recorded.totals.read);
});
