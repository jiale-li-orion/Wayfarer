import assert from "node:assert/strict";
import { test } from "node:test";
import type { Endpoints } from "../src/adapters/registry";
import { modelAnalysis } from "../src/core/modelAnalysis";

const ref = { endpoint: "laboratory", path: "/experiment/run.json" };
const run = {
  schema: "wayfarer.model/1",
  runId: "fixture",
  segment: "first",
  rank: 0,
};
function registry(files: Record<string, string>): Endpoints {
  return {
    get: () => ({
      config: { kind: "ssh" },
      call: async (op: string, a: any) => {
        const data = Buffer.from(files[a.path] ?? "");
        if (op === "stat") return { kind: "file", size: data.length };
        return data.subarray(a.offset, a.offset + a.length).toString("base64");
      },
    }),
  } as unknown as Endpoints;
}
test("resume at a complete UTF-8 event; growing partial line is read exactly once", async () => {
  const path = "/experiment/events.jsonl",
    first = JSON.stringify({ seq: 1, label: "中文" }) + "\n";
  const files: Record<string, string> = {
    [ref.path]: JSON.stringify(run),
    [path]: first + '{"seq":',
  };
  const endpoints = registry(files);
  const a = await modelAnalysis(endpoints, { ref, view: "events" });
  assert.equal(a.events?.length, 1);
  assert.equal(a.cursor, Buffer.byteLength(first));
  assert.equal(
    (await modelAnalysis(endpoints, { ref, view: "events", cursor: a.cursor }))
      .events?.length,
    0,
  );
  files[path] += "2}\n";
  assert.deepEqual(
    (await modelAnalysis(endpoints, { ref, view: "events", cursor: a.cursor }))
      .events,
    [{ seq: 2 }],
  );
});
test("select sample and module on a matching run/rank/attempt", async () => {
  const path = "/experiment/step-2.json";
  const step = {
    ...run,
    attempt: 2,
    modules: [{ name: "q" }, { name: "v" }],
    microbatches: [{ samples: [{ id: "a" }, { id: "b" }] }],
  };
  const files = {
    [ref.path]: JSON.stringify(run),
    [path]: JSON.stringify(step),
  };
  const endpoints = registry(files);
  const result = await modelAnalysis(endpoints, {
    ref,
    view: "step",
    attempt: 2,
    module: "v",
    sample: "b",
  });
  assert.deepEqual(result.step.modules, [{ name: "v" }]);
  assert.deepEqual(result.step.microbatches, [{ samples: [{ id: "b" }] }]);
  files[path] = JSON.stringify({ ...step, rank: 1 });
  await assert.rejects(
    modelAnalysis(endpoints, { ref, view: "step", attempt: 2 }),
    /不匹配/,
  );
});
