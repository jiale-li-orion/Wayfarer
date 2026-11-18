import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Core } from "../src/core/core";
import { Profiler } from "../src/core/log";
import { WorkspaceStore, workspaceUriKey } from "../src/core/workspaces";
import { recipe } from "../src/packages/catalog";
const quiet = new Profiler(() => {});
async function fixture(run: (core: Core, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-env-"));
  const core = new Core(
    path.join(dir, "state"),
    path.resolve("helpers/endpoint.py"),
    quiet,
  );
  try {
    await core.init([
      {
        id: "a",
        kind: process.platform === "win32" ? "windows" : "local",
        name: "Fixture",
        root: dir,
      },
    ]);
    await run(core, dir);
  } finally {
    await core.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("global favorites share atomic updates across independent stores and preserve exact native URI", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wm-favorites-"));
  try {
    const one = new WorkspaceStore(dir),
      two = new WorkspaceStore(dir);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? one : two).save({
          name: "中文 项目 " + i,
          uri: "file:///C:/projects/project%20" + i,
        }),
      ),
    );
    let values = await one.list();
    assert.equal(values.length, 12);
    const id = values[1].id;
    await two.update(id, { name: "Renamed", direction: "up" });
    values = await one.list();
    assert.equal(values[0].id, id);
    assert.equal(values[0].name, "Renamed");
    await one.update(id, { remove: true });
    assert.equal((await two.list()).length, 11);
    assert.equal(
      await fs.stat(path.join(dir, "workspaces.json.lock")).catch(() => null),
      null,
    );
    assert.throws(() =>
      one.save({ name: "bad", uri: "command:workbench.action.reloadWindow" }),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("environment declarations are bounded and separate from selected installed interpreter", async () =>
  fixture(async (core, dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname="example"\nrequires-python=">=3.11"\ndependencies=["requests>=2", "private @ https://user:secret@example.com/a"]\n[dependency-groups]\ndev=["pytest"]\n',
    );
    await fs.writeFile(path.join(dir, "uv.lock"), "version = 1");
    await fs.writeFile(path.join(dir, ".python-version"), "3.12\n");
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "web",
        packageManager: "pnpm@10",
        engines: { node: ">=22" },
        dependencies: { react: "^19" },
        scripts: { secret: "DO_NOT_RETURN" },
      }),
    );
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const ref = { endpoint: "a", path: dir };
    const s = await core.dispatch("inspect", { ref, environment: true });
    assert.equal(s.value.python.manager, "uv");
    assert.equal(s.value.python.requiresPython, ">=3.11");
    assert.equal(s.value.python.versionFile, "3.12");
    assert.equal(s.value.python.project, true);
    assert.equal(s.value.node.locks[0], "pnpm-lock.yaml");
    assert(!JSON.stringify(s).includes("secret"));
    assert(!JSON.stringify(s).includes("DO_NOT_RETURN"));
    assert.equal(s.value.python.selectedPython, undefined);
    await fs.writeFile(path.join(dir, "pyproject.toml"), "invalid = =");
    const fresh = await core.dispatch("inspect", {
      ref,
      environment: true,
      refresh: true,
    });
    assert.equal(fresh.value.errors[0].file, "pyproject.toml");
    assert.equal(fresh.value.node.name, "web");
  }));
test("environment choices persist separately from workspace and editor configuration", async () =>
  fixture(async (core, dir) => {
    const ref = { endpoint: "a", path: dir };
    const file = path.join(dir, "interpreter");
    await fs.writeFile(file, "fixture");
    await core.dispatch("environmentSelect", { ref, choice: { python: file } });
    const detail = await core.dispatch("inspect", { ref, environment: true });
    assert.equal(detail.value.python.selectedPython, file);
    await fs.unlink(file);
    const next = await core.dispatch("inspect", {
      ref,
      environment: true,
      refresh: true,
    });
    assert.equal(next.value.python.selectionMissing, true);
    await assert.rejects(() =>
      core.dispatch("environmentSelect", {
        ref,
        choice: { python: "relative/python" },
      }),
    );
    assert.equal(
      await fs.stat(path.join(dir, ".vscode")).catch(() => null),
      null,
    );
  }));
test("uv project recipes preserve declarations and locks while independent installs bind an interpreter", () => {
  const base = {
    endpoint: "x",
    cwd: "/tmp/中文 project",
    manager: "uv",
    executable: "/tools/uv",
  };
  const add = recipe({ ...base, action: "project-add", packages: ["httpx"] });
  assert.deepEqual(add.argv, [
    "/tools/uv",
    "add",
    "--no-sync",
    "--no-python-downloads",
    "httpx",
  ]);
  assert.equal(add.env?.UV_PROJECT_ENVIRONMENT, "/tmp/中文 project/.venv");
  assert.equal(add.mutating, true);
  const sync = recipe({ ...base, action: "project-sync" });
  assert(sync.argv.includes("--locked"));
  assert(!sync.argv.includes("--upgrade"));
  assert.deepEqual(
    recipe({ ...base, action: "list", python: "/custom/bin/python" }).argv,
    ["/tools/uv", "pip", "list", "--python", "/custom/bin/python"],
  );
  assert.equal(recipe({ ...base, action: "python-installed" }).mutating, false);
  assert.throws(() => recipe({ ...base, action: "project-add", packages: [] }));
  const win = recipe({
    ...base,
    cwd: "C:\\projects\\foo",
    action: "project-sync",
  });
  assert.equal(win.env?.UV_PROJECT_ENVIRONMENT, "C:\\projects\\foo\\.venv");
});
test("uv project tasks reject missing environment before launching the manager", async () =>
  fixture(async (core, dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname="fixture"\nversion="0.1.0"',
    );
    const j = await core.dispatch("package", {
      endpoint: "a",
      cwd: dir,
      manager: "uv",
      action: "project-sync",
      executable: "invalid-manager",
    });
    for (
      let i = 0;
      i < 100 && ["queued", "running"].includes(core.jobs.get(j.id).state);
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const result = await core.jobs.details(j.id);
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", /已有环境/);
    assert.equal(
      await fs.stat(path.join(dir, ".venv")).catch(() => null),
      null,
    );
  }));

test("Windows native workspace identity folds case while POSIX paths remain distinct", () => {
  assert.equal(
    workspaceUriKey("file:///C:/Work/Example"),
    workspaceUriKey("file:///c:/work/example"),
  );
  assert.notEqual(
    workspaceUriKey("vscode-remote://ssh-remote+train/Work/Example"),
    workspaceUriKey("vscode-remote://ssh-remote+train/work/example"),
  );
});

test("preview names the same selected uv environment as the runner", () => {
  const input = {
    endpoint: "x",
    cwd: "/project",
    manager: "uv",
    action: "project-sync",
    python: "/envs/special/bin/python",
  };
  const plan = recipe(input);
  assert.equal(plan.env?.UV_PROJECT_ENVIRONMENT, "/envs/special");
  assert(plan.argv.includes("/envs/special/bin/python"));
});
