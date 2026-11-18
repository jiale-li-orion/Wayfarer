import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Core } from "../src/core/core.ts";
import { Profiler } from "../src/core/log.ts";
const uv = "/home/lijiale/.local/bin/uv",
  python = "/data/services/miniforge3/bin/python3";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wayfarer-uv-"));
const core = new Core(
  path.join(dir, "state"),
  path.resolve("helpers/endpoint.py"),
  new Profiler(() => {}),
);
const result = { started: new Date().toISOString(), operations: [] };
process.env.UV_OFFLINE = "1";
try {
  await core.init([
    { id: "fixture", name: "Fixture", kind: "local", root: dir },
  ]);
  await fs.writeFile(
    path.join(dir, "pyproject.toml"),
    '[project]\nname="wayfarer-uv-fixture"\nversion="0.1.0"\nrequires-python=">=3.11"\ndependencies=[]\n',
  );
  execFileSync(
    uv,
    [
      "venv",
      "--no-python-downloads",
      "--python",
      python,
      path.join(dir, ".venv"),
    ],
    { cwd: dir },
  );
  execFileSync(
    python,
    [
      "-c",
      String.raw`import zipfile; z=zipfile.ZipFile('fixture_dep-0.1.0-py3-none-any.whl','w');z.writestr('fixture_dep/__init__.py','VERSION="0.1.0"');z.writestr('fixture_dep-0.1.0.dist-info/METADATA','Metadata-Version: 2.1\nName: fixture-dep\nVersion: 0.1.0\n');z.writestr('fixture_dep-0.1.0.dist-info/WHEEL','Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n');z.writestr('fixture_dep-0.1.0.dist-info/RECORD','fixture_dep/__init__.py,,\nfixture_dep-0.1.0.dist-info/METADATA,,\nfixture_dep-0.1.0.dist-info/WHEEL,,\nfixture_dep-0.1.0.dist-info/RECORD,,\n');z.close()`,
    ],
    { cwd: dir },
  );
  async function run(action, packages) {
    const before = performance.now();
    const input = {
      endpoint: "fixture",
      cwd: dir,
      manager: "uv",
      executable: uv,
      action,
      ...(action === "list"
        ? { python: path.join(dir, ".venv/bin/python") }
        : {}),
      ...(packages ? { packages } : {}),
    };
    const plan = await core.dispatch("packagePlan", input);
    const j = await core.dispatch("package", input);
    while (["running", "queued"].includes(core.jobs.get(j.id).state))
      await new Promise((r) => setTimeout(r, 20));
    const full = await core.jobs.details(j.id);
    assert.equal(
      full.state,
      "completed",
      full.error + "\n" + full.logs.join("\n"),
    );
    result.operations.push({
      action,
      ms: performance.now() - before,
      plan,
      exitCode: full.result.exitCode,
      logs: full.logs,
    });
    return full;
  }
  await run("project-add", ["./fixture_dep-0.1.0-py3-none-any.whl"]);
  assert(
    (await fs.readFile(path.join(dir, "pyproject.toml"), "utf8")).includes(
      "fixture-dep",
    ),
  );
  assert(
    (await fs.readFile(path.join(dir, "uv.lock"), "utf8")).includes(
      "fixture-dep",
    ),
  );
  const vpy = path.join(dir, ".venv/bin/python");
  assert.equal(
    execFileSync(
      vpy,
      [
        "-c",
        'import importlib.util;print(importlib.util.find_spec("fixture_dep"))',
      ],
      { encoding: "utf8" },
    ).trim(),
    "None",
  );
  await run("project-sync");
  assert.equal(
    execFileSync(vpy, ["-c", "import fixture_dep;print(fixture_dep.VERSION)"], {
      encoding: "utf8",
    }).trim(),
    "0.1.0",
  );
  await run("list");
  await run("project-update", ["fixture-dep"]);
  await run("project-remove", ["fixture-dep"]);
  assert(
    !(await fs.readFile(path.join(dir, "pyproject.toml"), "utf8")).includes(
      "fixture-dep",
    ),
  );
  await run("project-sync");
  assert.equal(
    execFileSync(
      vpy,
      [
        "-c",
        'import importlib.util;print(importlib.util.find_spec("fixture_dep"))',
      ],
      { encoding: "utf8" },
    ).trim(),
    "None",
  );
  result.diagnostics = await core.dispatch("diagnostics");
  result.completed = new Date().toISOString();
  await fs.writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      operations: result.operations.map((x) => ({
        action: x.action,
        ms: x.ms,
      })),
      passed: true,
    }),
  );
} finally {
  await core.dispose();
  await fs.rm(dir, { recursive: true, force: true });
}
