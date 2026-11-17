import path from "node:path";
import { parseDocument, isSeq } from "yaml";
import type { Core } from "../core/core";
import type { Bridge } from "./bridge";
async function execute(e: any, argv: string[], cwd: string) {
  const { id } = await e.call("execStart", { argv, cwd });
  let output = "";
  for (;;) {
    const r = await e.call("execPoll", { id });
    output += r.output;
    if (r.code !== null) {
      if (r.code !== 0) throw Error(output || "Command exited " + r.code);
      return output;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
export async function connectCodex(
  core: Core,
  bridge: Bridge,
  endpoint: string,
) {
  const e = core.endpoints.get(endpoint);
  const info = await e.call("info");
  const codex = await e.call("which", { name: "codex" });
  if (!codex) throw Error("Codex CLI not found on selected endpoint");
  const c = bridge.connections.find((x) => x.endpoint === endpoint);
  if (!c) throw Error("Choose a local or WSL MCP endpoint");
  const config = bridge.config(c);
  return execute(
    e,
    [
      codex,
      "mcp",
      "add",
      "workspace-map",
      "--",
      config.command,
      ...config.args,
    ],
    info.home,
  );
}
export async function dshProfiles(core: Core, endpoint: string) {
  const e = core.endpoints.get(endpoint);
  const info = await e.call("info");
  const launcher = await e.call("which", { name: "dsh" });
  if (!launcher) throw Error("dsh command not found on selected endpoint");
  const root = path.posix.join(info.home, ".dsh/profiles");
  const entries: any[] = [];
  let cursor;
  do {
    const p: any = await e.call("list", { path: root, cursor });
    entries.push(...p.entries.filter((v: any) => v.kind === "directory"));
    cursor = p.cursor;
  } while (cursor);
  const profiles = await Promise.all(
    entries.map(async (v) => {
      let file = "cordis.yml";
      try {
        const manifest = JSON.parse(
          Buffer.from(
            await e.call("read", {
              path: path.posix.join(v.path, "package.json"),
              length: 1048576,
            }),
            "base64",
          ).toString("utf8"),
        );
        if (Array.isArray(manifest.dsh?.profile?.bundles))
          file = "cordis.patch.yml";
      } catch {}
      const profilePath = path.posix.join(v.path, file);
      if (file === "cordis.yml") {
        try {
          const stat = await e.call("stat", { path: profilePath });
          if (!["file", "symlink"].includes(stat.kind)) return null;
        } catch {
          return null;
        }
      }
      return { name: v.name, path: profilePath };
    }),
  );
  return {
    launcher,
    profiles: profiles.filter(
      (p): p is { name: string; path: string } => p !== null,
    ),
  };
}
export async function connectDsh(
  core: Core,
  bridge: Bridge,
  endpoint: string,
  profile: string,
) {
  const e = core.endpoints.get(endpoint);
  const c = bridge.connections.find((x) => x.endpoint === endpoint);
  if (!c) throw Error("Choose a local or WSL MCP endpoint");
  const patch = path.posix.basename(profile) === "cordis.patch.yml";
  let text = "[]\n";
  try {
    const stat = await e.call("stat", { path: profile });
    if (stat.size > 1048576)
      throw Error("Profile too large for inline configuration editing");
    text = Buffer.from(
      await e.call("read", { path: profile, length: 1048576 }),
      "base64",
    ).toString("utf8");
  } catch (error: any) {
    if (
      !patch ||
      !(
        ["ENOENT", 2].includes(error.code) || error.type === "FileNotFoundError"
      )
    )
      throw error;
  }
  const doc = parseDocument(text);
  if (doc.errors.length) throw Error(doc.errors[0].message);
  // Current bundle profiles use ordered patch layers; legacy profiles contain plugins directly.
  const plugins = (
    isSeq(doc.contents) ? doc.contents : doc.get("plugins", true)
  ) as any;
  if (!plugins || !Array.isArray(plugins.items))
    throw Error(
      "Current dsh profile has no supported plugin sequence; inspect the running version before adapting",
    );
  const config = bridge.config(c);
  const own = {
    id: "mcp-workspace-map",
    name: "@deepseek-ai/dsh-mcp-client",
    config: { serverName: "workspace_map", transport: "stdio", ...config },
  };
  const containers = patch
    ? plugins.items.map((n: any) => n?.get?.("insert", true)).filter(isSeq)
    : [plugins];
  const node = containers
    .flatMap((seq: any) => seq.items)
    .find((n: any) => n?.get?.("id") === own.id);
  if (node) {
    node.set("name", own.name);
    if (!node.get("config", true)) node.set("config", doc.createNode({}));
    const configuration = node.get("config", true);
    for (const [key, value] of Object.entries(own.config))
      configuration.set(key, doc.createNode(value));
  } else plugins.add(doc.createNode(patch ? { insert: [own] } : own));
  const job = await core.dispatch("write", {
    ref: { endpoint, path: profile },
    content: doc.toString(),
  });
  await new Promise<void>((resolve, reject) => {
    const done = (j: any) => {
      if (j.id !== job.id) return;
      if (j.state === "completed") {
        core.jobs.off("change", done);
        resolve();
      } else if (["failed", "cancelled", "paused"].includes(j.state)) {
        core.jobs.off("change", done);
        reject(Error(j.error ?? j.state));
      }
    };
    core.jobs.on("change", done);
    done(core.jobs.get(job.id));
  });
  return { profile, plugin: own };
}
