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
  const { id, pid } = await e.call("execStart", {
    argv: plan.argv,
    cwd: plan.cwd,
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
