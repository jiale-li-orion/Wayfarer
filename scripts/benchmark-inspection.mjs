import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [baseline, output] = process.argv.slice(2);
const results = [];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayfarer-inspection-"));
try {
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.mkdir(path.join(root, ".venv"));
  await fs.writeFile(
    path.join(root, "pyproject.toml"),
    '[project]\nname="fixture"',
  );
  for (const [version, source] of [
    ["0.4.0", baseline],
    ["0.5.0", process.cwd()],
  ]) {
    const { Core } = await import(
      pathToFileURL(path.join(source, "src/core/core.ts"))
    );
    const { Profiler } = await import(
      pathToFileURL(path.join(source, "src/core/log.ts"))
    );
    const core = new Core(
      path.join(root, "state-" + version),
      path.join(source, "helpers/endpoint.py"),
      new Profiler(() => {}),
    );
    await core.init([{ id: "fixture", kind: "local", name: "Fixture", root }]);
    const endpoint = core.endpoints.get("fixture"),
      original = endpoint.call.bind(endpoint),
      counts = {};
    endpoint.call = (method, args) => {
      counts[method] = (counts[method] ?? 0) + 1;
      return original(method, args);
    };
    const ref = { endpoint: "fixture", path: root };
    await core.dispatch("inspect", { ref });
    for (const key of Object.keys(counts)) delete counts[key];
    const cold = [];
    const before = process.cpuUsage();
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await core.dispatch("inspect", { ref, refresh: true });
      cold.push(performance.now() - t);
    }
    const after = process.cpuUsage(before);
    const cached = [];
    const saved = { ...counts };
    for (let i = 0; i < 1000; i++) {
      const t = performance.now();
      await core.dispatch("inspect", { ref });
      cached.push(performance.now() - t);
    }
    const percentile = (a, p) =>
      a.sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
    results.push({
      version,
      iterations: 100,
      coldP50: percentile(cold, 0.5),
      coldP95: percentile(cold, 0.95),
      cachedP50: percentile(cached, 0.5),
      cachedP95: percentile(cached, 0.95),
      cpuMs: (after.user + after.system) / 1000,
      calls: saved,
      cacheAdditionalCalls: Object.fromEntries(
        Object.keys(counts).map((k) => [k, counts[k] - (saved[k] ?? 0)]),
      ),
      inspector: core.inspector.stats(),
    });
    await core.dispose();
  }
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        scope:
          "same-host native fixture; counts are adapter calls, not measured network RTT",
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
