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
type CodexServer = { enabled?: boolean; transport?: { command?: string; args?: string[] } };
async function configuredCodex(e: any, codex: string, home: string): Promise<CodexServer | undefined> {
  try { return JSON.parse(await execute(e, [codex, "mcp", "get", "workspace-map", "--json"], home)); }
  catch (error) {
    if (/not found|no mcp server named|does not exist/i.test(String(error))) return undefined;
    throw error;
  }
}
export async function readCodexBinding(core: Core, endpoint: string) {
  const e = core.endpoints.get(endpoint);
  const info = await e.call("info");
  const codex = await e.call<string>("which", { name: "codex" });
  if (!codex) return { state: "unavailable" as const };
  const value = await configuredCodex(e, codex, info.home);
  const args = value?.transport?.args ?? [];
  const index = args.indexOf("--map");
  return {
    state: value ? value.enabled === false ? "disabled" as const : "configured" as const : "missing" as const,
    mapId: index >= 0 ? args[index + 1] : undefined,
  };
}

// Compare the complete parsed configuration before replacing only the known args array.
const replaceCodexArgs = String.raw`
import copy, json, os, re, stat, sys, tempfile, tomllib
from pathlib import Path
p = (Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser() / "config.toml").resolve(strict=True)
previous, replacement = map(json.loads, sys.argv[1:])
raw = p.read_bytes().decode("utf-8")
base = tomllib.loads(raw)
server = base["mcp_servers"]["workspace-map"]
if server.get("args") != previous:
    raise ValueError("Codex 绑定已变动，请重新打开配置")
header = re.search(r'^\s*\[mcp_servers\.(?:workspace-map|"workspace-map"|\'workspace-map\')\]\s*$', raw, re.M)
if not header:
    raise ValueError("找不到可更新的 Wayfarer 配置块")
start = header.end()
next_header = re.search(r'^\s*\[', raw[start:], re.M)
end = start + next_header.start() if next_header else len(raw)
section = raw[start:end]
match = re.search(r'(?m)^(\s*args\s*=\s*)\[[\s\S]*?\]', section)
if not match:
    raise ValueError("找不到可更新的 Wayfarer 启动参数")
updated = raw[:start+match.start()] + match.group(1) + json.dumps(replacement, ensure_ascii=False) + raw[start+match.end():]
expected = copy.deepcopy(base)
expected["mcp_servers"]["workspace-map"]["args"] = replacement
if tomllib.loads(updated) != expected:
    raise ValueError("仅更新 Wayfarer 启动参数的校验失败")
fd, tmp = tempfile.mkstemp(prefix=".wayfarer-",dir=str(p.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        os.fchmod(target.fileno(), stat.S_IMODE(p.stat().st_mode))
        target.write(updated)
        target.flush()
        os.fsync(target.fileno())
    if p.read_bytes().decode("utf-8") != raw:
        raise ValueError("Codex 配置正在修改，请重试")
    os.replace(tmp, p)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
`;

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
  const current = await configuredCodex(e, codex, info.home);
  if (current) {
    const previous = current.transport?.args;
    if (current.transport?.command !== config.command || !Array.isArray(previous))
      throw Error("当前 Codex 入口与此窗口的启动方式不同，请先核对 MCP 配置");
    const helper = previous.findIndex((value) =>
      typeof value === "string" && /\/workspace-map\/client\/[a-f0-9]+\/mcp\.py$/.test(value));
    const binding = previous.indexOf("--map");
    const legacy = previous.indexOf("--session");
    const index = binding >= 0 ? binding : legacy;
    if (helper < 0 || index < 0 || !previous[index + 1])
      throw Error("当前配置的启动参数需通过 MCP 配置界面调整");
    const next = previous.slice();
    next[helper] = config.args[1];
    next[index] = "--map";
    next[index + 1] = bridge.mapId;
    if (JSON.stringify(next) === JSON.stringify(previous)) return "";
    await execute(e, [e.config.python ?? "python3", "-c", replaceCodexArgs, JSON.stringify(previous), JSON.stringify(next)], info.home);
    return "";
  }
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
