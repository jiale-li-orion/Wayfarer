import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect, sleep } from "./lib/live.mjs";
const execute = promisify(execFile),
  live = await connect(),
  { ipc } = live;
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "workspace-map-packages-"),
);
const output = process.argv[2];
if (!output) throw Error("Specify output JSON");
const results = [];
async function which(name) {
  return execute("which", [name]).then(
    (r) => r.stdout.trim(),
    () => null,
  );
}
async function run(input, cancel = false) {
  const plan = await ipc("packagePlan", input),
    start = performance.now(),
    j = await ipc("package", input);
  let maxHelperRss = 0,
    maxChildRss = 0,
    childPids = new Set(),
    cancelled = false;
  while (true) {
    const state = await ipc("job", { id: j.id }),
      r = await ipc("resources", { endpoint: "wsl-ubuntu" });
    maxHelperRss = Math.max(maxHelperRss, r.rss);
    for (const c of r.children ?? []) {
      childPids.add(c.pid);
      maxChildRss = Math.max(maxChildRss, c.rss ?? 0);
    }
    if (
      cancel &&
      !cancelled &&
      state.logs?.some((l) => l.includes("fixture-ready"))
    ) {
      await ipc("jobControl", { id: j.id, action: "cancel" });
      cancelled = true;
    }
    if (["completed", "failed", "cancelled", "paused"].includes(state.state)) {
      const record = {
        manager: input.manager,
        action: input.action,
        endpoint: input.endpoint,
        python: input.python,
        plan,
        ms: performance.now() - start,
        state: state.state,
        error: state.error,
        output: state.logs?.join("").slice(-1200),
        maxHelperRss,
        maxChildRss,
        childPids: [...childPids],
      };
      results.push(record);
      assert.equal(
        state.state,
        cancel ? "cancelled" : "completed",
        JSON.stringify(record),
      );
      return record;
    }
    await sleep(100);
  }
}
try {
  const endpoint = "wsl-ubuntu",
    uv = await which("uv"),
    python = path.join(root, "venv/bin/python");
  if (uv) {
    await execute(uv, ["venv", path.join(root, "venv")]);
    const py =
      "import sys,zipfile,pathlib\np=pathlib.Path(sys.argv[1])/'wm_profile_fixture-1.0.0-py3-none-any.whl'\nfiles={'wm_profile_fixture.py':'VALUE=1\\n','wm_profile_fixture-1.0.0.dist-info/METADATA':'Metadata-Version: 2.1\\nName: wm-profile-fixture\\nVersion: 1.0.0\\n','wm_profile_fixture-1.0.0.dist-info/WHEEL':'Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n','wm_profile_fixture-1.0.0.dist-info/RECORD':''}\nwith zipfile.ZipFile(p,'w') as z:\n for n,v in files.items():z.writestr(n,v)";
    await execute("python3", ["-c", py, root]);
    for (const [action, packages] of [
      [
        "install",
        [path.join(root, "wm_profile_fixture-1.0.0-py3-none-any.whl")],
      ],
      ["list", []],
      ["uninstall", ["wm-profile-fixture"]],
    ])
      await run({
        endpoint,
        cwd: root,
        manager: "uv",
        executable: uv,
        python,
        action,
        packages,
      });
  }
  const pkg = path.join(root, "fixture-package");
  await fs.mkdir(pkg);
  await fs.writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "wm-profile-fixture", version: "1.0.0" }),
  );
  for (const manager of ["pnpm", "bun"]) {
    const executable = await which(manager);
    if (!executable) {
      results.push({ manager, available: false });
      continue;
    }
    const cwd = path.join(root, manager);
    await fs.mkdir(cwd);
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "wm-test-" + manager,
        version: "1.0.0",
        private: true,
      }),
    );
    await fs.writeFile(
      path.join(cwd, ".npmrc"),
      "audit=false\nfund=false\nupdate-notifier=false\nstore-dir=" +
        path.join(root, "store") +
        "\n",
    );
    for (const [action, packages] of [
      ["install", [pkg]],
      ["list", []],
      ["uninstall", ["wm-profile-fixture"]],
    ])
      await run({ endpoint, cwd, manager, executable, action, packages });
  }
  for (const manager of ["java", "cargo", "rustup"]) {
    const executable = await which(manager);
    if (executable)
      await run({
        endpoint,
        cwd: root,
        manager,
        executable,
        action: manager === "java" ? "info" : "list",
      });
    else results.push({ manager, available: false });
  }
  for (const manager of ["gradle", "maven"]) {
    const cacheRoot = path.join(root, manager),
      entry = path.join(cacheRoot, "fixture");
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, "cache.bin"), Buffer.alloc(1024));
    await run({
      endpoint,
      cwd: root,
      manager,
      action: "cache-info",
      cacheRoot,
    });
    await run({
      endpoint,
      cwd: root,
      manager,
      action: "cache-clean-entry",
      cacheRoot,
      entry,
    });
    assert.equal(
      await fs.stat(entry).then(
        () => true,
        () => false,
      ),
      false,
    );
  }
  const npm = await which("npm");
  if (npm) {
    const cwd = path.join(root, "cancel-project"),
      pack = path.join(root, "cancel-package");
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(pack, "package"), { recursive: true });
    await fs.writeFile(
      path.join(pack, "package/package.json"),
      JSON.stringify({
        name: "wm-profile-cancel",
        version: "1.0.0",
        scripts: { postinstall: "node hook.js" },
      }),
    );
    await fs.writeFile(
      path.join(pack, "package/hook.js"),
      'console.log("fixture-ready");setInterval(()=>{},1000);',
    );
    const archive = path.join(root, "cancel.tgz");
    await execute("tar", ["-czf", archive, "-C", pack, "package"]);
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "wm-cancel-test",
        version: "1.0.0",
        private: true,
      }),
    );
    await fs.writeFile(
      path.join(cwd, ".npmrc"),
      "audit=false\nfund=false\nforeground-scripts=true\ncache=" +
        path.join(root, "npm-cache") +
        "\n",
    );
    const record = await run(
      {
        endpoint,
        cwd,
        manager: "npm",
        executable: npm,
        action: "install",
        packages: [archive],
      },
      true,
    );
    await sleep(300);
    const r = await ipc("resources", { endpoint });
    assert.equal(r.processes, 0);
    for (const pid of record.childPids)
      assert.equal(
        await fs.stat("/proc/" + pid).then(
          () => true,
          () => false,
        ),
        false,
      );
    results.push({ cancelReaped: true, resources: r });
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(results, null, 2));
  live.close();
  console.log(output);
}
