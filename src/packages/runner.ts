import type { Endpoints } from "../adapters/registry";
import type { JobContext } from "../core/jobs";
import { recipe, type PackageInput } from "./catalog";
import { contains, pathApi } from "../shared/paths";
export async function runPackage(endpoints: Endpoints, ctx: JobContext) {
  const i = ctx.job.input as PackageInput;
  const e = endpoints.get(i.endpoint);
  const plan = recipe(i);
  ctx.log(JSON.stringify({ endpoint: i.endpoint, ...plan }));
  if (
    ["gradle", "maven"].includes(i.manager) &&
    i.action.startsWith("cache-")
  ) {
    const info = await e.call("info");
    const p = pathApi(e.config);
    const root =
      i.cacheRoot ??
      p.join(
        info.home,
        i.manager === "gradle" ? ".gradle" : ".m2",
        i.manager === "gradle" ? "caches" : "repository",
      );
    const resolvedRoot = await e.call<string>("realpath", { path: root });
    if (i.action === "cache-clean-entry") {
      if (!i.entry) throw Error("Select a specific cache entry");
      const resolved = await e.call<string>("realpath", { path: i.entry });
      if (
        resolved === resolvedRoot ||
        !contains(
          resolvedRoot.replaceAll("\\", "/"),
          resolved.replaceAll("\\", "/"),
        )
      )
        throw Error("Select an entry inside the manager cache");
      ctx.log("Permanent delete cache entry: " + resolved);
      ctx.check();
      await e.call("remove", { path: i.entry, recursive: true });
      return { removed: i.entry };
    }
    let cursor: string | undefined;
    let result: any;
    try {
      do {
        ctx.check();
        result = await e.call("list", { path: root, kind: "size", cursor });
        cursor = result.cursor;
        ctx.progress({ bytes: result.bytes, files: result.files });
      } while (cursor);
    } finally {
      if (cursor) await e.call("scanClose", { cursor });
    }
    return { root, ...result };
  }
  ctx.check();
  const env: Record<string, string> = {};
  if (i.manager === "uv" && i.action.startsWith("project-")) {
    const pp = pathApi(e.config);
    const manifest = await e.call("stat", {
      path: pp.join(i.cwd, "pyproject.toml"),
    });
    if (manifest.kind !== "file")
      throw Error("选择包含 pyproject.toml 的项目根目录");
    // Project operations never inherit an unrelated active environment.
    const root = i.python
      ? pp.dirname(pp.dirname(i.python))
      : pp.join(i.cwd, ".venv");
    if (
      i.python &&
      (!pp.isAbsolute(i.python) ||
        !/[\\/](bin|Scripts)[\\/]python[^\\/]*$/i.test(i.python))
    )
      throw Error("选择现有虚拟环境中的 Python 解释器");
    if (i.python) {
      const markers: any[] = await e.call("statMany", {
        paths: [pp.join(root, "pyvenv.cfg"), pp.join(root, "conda-meta")],
      });
      if (!markers.some((m) => m.kind === "file" || m.kind === "directory"))
        throw Error("所选 Python 缺少虚拟环境标记");
    }
    const python =
      i.python ??
      pp.join(
        root,
        e.config.kind === "windows" ? "Scripts/python.exe" : "bin/python",
      );
    const s = await e.call("stat", { path: python }).catch(() => undefined);
    if (
      !s ||
      !(s.kind === "file" || (s.kind === "symlink" && s.targetKind === "file"))
    )
      throw Error("项目 .venv 尚未就绪；本轮仅管理已有环境");
    env.UV_PROJECT_ENVIRONMENT = root;
    env.UV_PYTHON_DOWNLOADS = "never";
  }
  if (
    i.manager === "uv" &&
    ["list", "install", "uninstall", "update"].includes(i.action) &&
    !i.python
  )
    throw Error("选择具体 Python 解释器后操作环境包");
  if (i.node) {
    const pp = pathApi(e.config);
    if (!pp.isAbsolute(i.node)) throw Error("Node 运行时需要绝对路径");
    const runtime = await e.call("stat", { path: i.node });
    if (
      runtime.kind !== "file" &&
      !(runtime.kind === "symlink" && runtime.targetKind === "file")
    )
      throw Error("Node 运行时路径已失效");
  }
  const { id, pid } = await e.call("execStart", {
    argv: plan.argv,
    cwd: plan.cwd,
    env,
    runtime: i.node,
  });
  ctx.job.checkpoint.process = { id, pid };
  await ctx.save();
  try {
    for (;;) {
      ctx.check();
      const v = await e.call("execPoll", { id });
      if (v.output) ctx.log(v.output);
      if (v.truncated) ctx.log("[manager output truncated to bounded buffer]");
      if (v.code !== null) {
        delete ctx.job.checkpoint.process;
        if (v.code !== 0) throw Error("Package manager exited " + v.code);
        return { exitCode: v.code, command: plan };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    await e.call("execCancel", { id }).then(
      (v) => {
        if (v.output) ctx.log(v.output);
        ctx.log("Cancellation requested; last exit status: " + v.code);
        ctx.job.result = { exitCode: v.code, command: plan, interrupted: true };
        ctx.job.checkpoint.process = {
          id,
          pid,
          exitCode: v.code,
          ended: Date.now(),
        };
      },
      () => {},
    );
    throw err;
  }
}
