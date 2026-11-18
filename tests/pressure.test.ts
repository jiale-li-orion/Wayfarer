import test from "node:test";
import assert from "node:assert/strict";
import { CapacityRefresh } from "../src/core/capacityRefresh";
import { pressureSignals } from "../src/shared/pressure";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("visible capacity probes merge bursts, suppress stale targets and release when hidden", async () => {
  let resolve!: (v: any) => void,
    calls = 0;
  const delivered: any[] = [];
  const controller = new CapacityRefresh(
    async (ref) => {
      calls++;
      if (calls === 1)
        return new Promise((r) => {
          resolve = r;
        });
      return ref;
    },
    (v) => delivered.push(v),
    (e) => {
      throw Error(e);
    },
    1,
  );
  try {
    controller.watch({ endpoint: "c", path: "C:/" });
    await pause(15);
    for (let i = 0; i < 20; i++) controller.request();
    controller.watch({ endpoint: "d", path: "D:/" });
    resolve({ endpoint: "c" });
    await pause(20);
    assert.equal(calls, 2);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].endpoint, "d");
    controller.request();
    controller.watch();
    await pause(10);
    assert.equal(calls, 2);
    for (let i = 0; i < 50; i++) {
      controller.watch({ endpoint: "c", path: "C:/" });
      controller.watch();
    }
    await pause(10);
    assert.equal(calls, 2);
  } finally {
    controller.dispose();
  }
});
test("pressure notices distinguish physical, commit, PSI and backing disk budgets", () => {
  assert.deepEqual(pressureSignals({}), []);
  const s = {
    system: {
      memory: { total: 100, available: 8, commitUsed: 90, commitLimit: 100 },
      pressure: { memory: { some: { avg10: 20 } } },
    },
    physicalBudget: { mount: "C:/", total: 100, available: 3 },
  };
  assert.equal(pressureSignals(s).length, 4);
  assert.deepEqual(
    pressureSignals({
      system: {
        memory: { total: 100, available: 50, swapTotal: 10, swapUsed: 9 },
      },
    }),
    [],
  );
});
