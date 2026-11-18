import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createWorkspaceCommands } from "./workspaces";
import { createEnvironmentView } from "./environmentView";
import { createSidebar } from "./sidebar";
import { createResourceView } from "./resources";
import { Core } from "./core/core";
import { EXIT_GRACE_MS } from "./core/lifecycle";
import { Profiler } from "./core/log";
import { Bridge } from "./mcp/bridge";
import { connectCodex, connectDsh, dshProfiles } from "./mcp/integrations";
import { FileProvider } from "./filesystem/provider";
import type { Ref, EndpointConfig } from "./shared/types";
import { pathApi } from "./shared/paths";
import { capabilities } from "./packages/catalog";
let active:
  { core: Core; bridge: Bridge; release: () => Promise<void> } | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Workspace Map", {
    log: true,
  });
  const profile = new Profiler((line) => output.info(line));
  // Each VS Code window owns its session; durable view/job records use a unique window store.
  let stored =
    context.workspaceState.get<string>("mapStorageId") ?? randomUUID();
  let storage = path.join(context.globalStorageUri.fsPath, stored);
  await fs.mkdir(storage, { recursive: true });
  const ownerToken = randomUUID();
  const owners = path.join(storage, "owners");
  await fs.mkdir(owners, { recursive: true });
  const files = (await fs.readdir(owners)).map((name) =>
    path.join(owners, name),
  );
  files.push(path.join(storage, "owner.json")); // Upgrade from the previous pid-only record.
  let occupied = false;
  for (const file of files) {
    const owner = await fs
      .readFile(file, "utf8")
      .then(JSON.parse, () => undefined);
    if (!owner) continue;
    try {
      process.kill(owner.pid, 0);
      occupied = true;
    } catch {
      await fs.unlink(file).catch(() => {});
    }
  }
  if (occupied) {
    stored = randomUUID();
    storage = path.join(context.globalStorageUri.fsPath, stored);
  }
  const ownerFile = path.join(storage, "owners", ownerToken + ".json");
  await fs.mkdir(path.dirname(ownerFile), { recursive: true });
  await fs.writeFile(
    ownerFile,
    JSON.stringify({ pid: process.pid, token: ownerToken, mapId: stored }),
    { mode: 0o600, flag: "wx" },
  );
  await context.workspaceState.update("mapStorageId", stored);
  // Each instance removes only the record whose name contains its own token.
  const release = () => fs.unlink(ownerFile).catch(() => {});
  const config = vscode.workspace.getConfiguration("workspaceMap");
  const helper = path.join(context.extensionPath, "dist/helpers/endpoint.py");
  const core = new Core(storage, helper, profile, {
    pageSize: config.get<number>("pageSize"),
    transferConcurrency: config.get<number>("transferConcurrency"),
    monitorPython: config.get<string>("monitorPython") || undefined,
    trash: async (p) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(p), {
        recursive: true,
        useTrash: true,
      });
    },
  });
  await core.init(config.get<EndpointConfig[]>("endpoints") ?? []);
  const bridge = new Bridge(
    core,
    path.join(context.extensionPath, "dist/helpers"),
    vscode.workspace.name ?? "Workspace Map",
    stored,
  );
  core.agentStats = () => bridge.stats();
  active = { core, bridge, release };
  void bridge.start();
  const provider = new FileProvider(core);
  context.subscriptions.push(
    output,
    provider,
    vscode.workspace.registerFileSystemProvider("workspacemap", provider, {
      isCaseSensitive: true,
    }),
    vscode.workspace.registerFileSystemProvider("workspacemap-win", provider, {
      isCaseSensitive: false,
    }),
  );
  context.subscriptions.push(createWorkspaceCommands(context, core));
  context.subscriptions.push(createEnvironmentView(context, core, provider));
  context.subscriptions.push(createSidebar(core));
  context.subscriptions.push(createResourceView(context, core));
  await vscode.commands.executeCommand(
    "setContext",
    "workspaceMap.textInputFocus",
    false,
  );
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let pendingAction: string | undefined;
  const flushAction = () => {
    if (ready && panel?.visible && pendingAction) {
      const action = pendingAction;
      pendingAction = undefined;
      void panel.webview.postMessage({ type: "uiAction", action });
    }
  };
  const open = (revived?: vscode.WebviewPanel) => {
    if (panel) {
      panel.reveal();
      return;
    }
    panel =
      revived ??
      vscode.window.createWebviewPanel(
        "workspaceMap",
        "Workspace Map",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
          ],
        },
      );
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    };
    core.directories.setVisible(panel.visible);
    panel.iconPath = new vscode.ThemeIcon("map");
    const webview = panel.webview;
    const nonce = randomUUID().replaceAll("-", "");
    const asset = (file: string) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", file))
        .toString();
    webview.html =
      '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' +
      webview.cspSource +
      " data:; style-src " +
      webview.cspSource +
      " 'unsafe-inline'; font-src " +
      webview.cspSource +
      "; script-src 'nonce-" +
      nonce +
      "'; connect-src " +
      webview.cspSource +
      '; worker-src blob:;"><link rel="stylesheet" href="' +
      asset("ui.css") +
      '"></head><body><div id="root"></div><script nonce="' +
      nonce +
      '">window.layoutUri=' +
      JSON.stringify(asset("layout.js")) +
      ';</script><script nonce="' +
      nonce +
      '" src="' +
      asset("ui.js") +
      '"></script></body></html>';
    let jobsSubscribed = false;
    let lastJobCount = -1;
    const send = (event: any) => {
      if (event.type === "job" && panel?.visible) {
        const count = core.jobs.busyCount();
        if (count !== lastJobCount) {
          lastJobCount = count;
          void webview.postMessage({ type: "jobCount", count });
        }
      }
      if (panel?.visible && (event.type !== "job" || jobsSubscribed))
        void webview.postMessage(event);
    };
    core.on("event", send);
    webview.onDidReceiveMessage(async (m) => {
      try {
        let result: any;
        switch (m.method) {
          case "textInputFocus":
            await vscode.commands.executeCommand(
              "setContext",
              "workspaceMap.textInputFocus",
              !!m.args.focused && !!panel?.active,
            );
            result = true;
            break;
          case "jobSubscription":
            jobsSubscribed = !!m.args.enabled;
            result = true;
            break;
          case "bootstrap":
            result = {
              endpoints: core.endpoints.configs(),
              view: core.view,
              jobs: core.jobs.active(),
              projects: core.inspector.projects(),
              capabilities,
              restored: core.restored,
            };
            break;
          case "favoriteDirectory":
            result = await vscode.commands.executeCommand(
              "workspaceMap.favoriteDirectory",
              m.args.ref,
            );
            break;
          case "environmentView":
            result = await vscode.commands.executeCommand(
              "workspaceMap.environment",
              [m.args.ref],
            );
            break;
          case "open":
            await openFile(m.args.ref);
            result = true;
            break;
          case "parent": {
            const r = m.args.ref;
            result = {
              endpoint: r.endpoint,
              path: pathApi(core.endpoints.get(r.endpoint).config).dirname(
                r.path,
              ),
            };
            break;
          }
          case "promptAction":
            result = await promptAction(m.args.action, m.args.refs);
            break;
          case "command":
            result = await commands(m.args.name);
            break;
          case "jobDetails": {
            const j = await core.jobs.details(m.args.id);
            const doc = await vscode.workspace.openTextDocument({
              language: "json",
              content: JSON.stringify(j, null, 2),
            });
            await vscode.window.showTextDocument(doc, {
              preview: true,
              viewColumn: vscode.ViewColumn.Beside,
            });
            result = true;
            break;
          }
          default:
            result = await core.dispatch(m.method, m.args);
        }
        await webview.postMessage({ id: m.id, result });
        if (m.method === "bootstrap") {
          ready = true;
          flushAction();
        }
      } catch (e) {
        await webview.postMessage({ id: m.id, error: String(e) });
      }
    });
    panel.onDidChangeViewState((e) => {
      core.directories.setVisible(e.webviewPanel.visible);
      if (!e.webviewPanel.active)
        void vscode.commands.executeCommand(
          "setContext",
          "workspaceMap.textInputFocus",
          false,
        );
      if (!e.webviewPanel.visible) {
        jobsSubscribed = false;
        ready = false;
      }
    });
    panel.onDidDispose(() => {
      core.off("event", send);
      panel = undefined;
      void vscode.commands.executeCommand(
        "setContext",
        "workspaceMap.textInputFocus",
        false,
      );
      ready = false;
      core.directories.setVisible(false);
      core.directories.watch([]);
    });
  };
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("workspaceMap", {
      async deserializeWebviewPanel(revived) {
        open(revived);
      },
    }),
  );
  const openFile = async (r: Ref) => {
    const e = core.endpoints.get(r.endpoint);
    const s = await e.call("stat", { path: r.path });
    if (s.kind === "directory") {
      await core.dispatch("navigate", { ref: r });
      open();
      return;
    }
    const uri = provider.uri(r);
    await vscode.commands.executeCommand("vscode.open", uri);
  };
  const chooseDestination = async () => {
    const endpoint = await vscode.window.showQuickPick(
      core.endpoints
        .configs()
        .map((e) => ({ label: e.name, description: e.root, id: e.id })),
      { title: "目标端点" },
    );
    if (!endpoint) return;
    const p = await vscode.window.showInputBox({
      title: "目标目录绝对路径",
      value: core.endpoints.get(endpoint.id).config.root,
    });
    if (!p) return;
    return { endpoint: endpoint.id, path: p };
  };
  const promptAction = async (action: string, refs: Ref[]) => {
    if (action === "locate") {
      const r = await chooseDestination();
      if (r) return core.dispatch("navigate", { ref: r });
      return;
    }
    const ref = refs[0];
    const e = core.endpoints.get(ref.endpoint);
    if (action === "open") return openFile(ref);
    if (action === "locate") {
      const r = await chooseDestination();
      if (r) return core.dispatch("navigate", { ref: r });
      return;
    }
    if (action === "create") {
      const kind = await vscode.window.showQuickPick(["文件", "目录"], {
        title: "新建",
      });
      if (!kind) return;
      const name = await vscode.window.showInputBox({ title: "名称" });
      if (!name) return;
      if (kind === "目录") return core.dispatch("mkdir", { ref, name });
      const result = await core.dispatch("write", {
        ref: {
          endpoint: ref.endpoint,
          path: pathApi(e.config).join(ref.path, name),
        },
        content: "",
        exclusive: true,
      });
      return result;
    }
    if (action === "rename") {
      const name = await vscode.window.showInputBox({
        title: "新名称",
        value: pathApi(e.config).basename(ref.path),
      });
      if (name) return core.dispatch("rename", { ref, name });
      return;
    }
    if (action === "delete") {
      const semantics = [
        ...new Set(
          refs.map((r) =>
            core.endpoints.get(r.endpoint).config.kind === "windows"
              ? "移入回收站"
              : "永久删除",
          ),
        ),
      ].join(" / ");
      const answer = await vscode.window.showWarningMessage(
        semantics + " " + refs.length + " 项",
        {
          modal: true,
          detail: refs.map((r) => r.endpoint + ": " + r.path).join("\n"),
        },
        "删除",
      );
      if (answer === "删除") return core.dispatch("delete", { refs });
      return;
    }
    if (action === "copy" || action === "move") {
      const target = await chooseDestination();
      if (!target) return;
      const choice = await vscode.window.showQuickPick(
        [
          { label: "保留两份，自动改名", value: "rename" },
          { label: "跳过同名", value: "skip" },
          { label: "合并目录，覆盖同名文件", value: "overwrite" },
        ],
        { title: "同名冲突处理" },
      );
      if (choice)
        return core.dispatch("transfer", {
          sources: refs,
          target,
          mode: action,
          conflict: choice.value,
        });
    }
  };
  const chooseConnection = async () => {
    if (!bridge.connections.length)
      throw Error("MCP bridge is still starting; check Workspace Map output");
    return vscode.window.showQuickPick(
      bridge.connections.map((c) => ({ label: c.distro ?? "Local", c })),
      { title: "Agent 所在环境" },
    );
  };
  const commands = async (name: string): Promise<any> => {
    if (name === "logs") {
      output.show();
      return;
    }
    if (name === "connections") {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "添加 / 导入 SSH", value: "add" },
          { label: "接入 Codex", value: "codex" },
          { label: "接入 dsh", value: "dsh" },
          { label: "MCP 配置", value: "config" },
          { label: "连接 / 断开端点", value: "endpoint" },
        ],
        { title: "连接" },
      );
      if (choice) return commands(choice.value);
      return;
    }
    if (name === "endpoint") {
      const endpoint = await vscode.window.showQuickPick(
        core.endpoints
          .configs()
          .filter((e) => e.kind === "ssh" || e.kind === "wsl")
          .map((e) => ({ label: e.name, id: e.id })),
        { title: "端点" },
      );
      if (!endpoint) return;
      const action = await vscode.window.showQuickPick(
        [
          { label: "连接", value: "connect" },
          { label: "断开", value: "disconnect" },
        ],
        { title: endpoint.label },
      );
      if (action)
        return core.dispatch("endpointControl", {
          endpoint: endpoint.id,
          action: action.value,
        });
      return;
    }
    if (name === "add") return addEndpoint(core, config);
    if (name === "codex") {
      const c = await chooseConnection();
      if (c) {
        const result = await connectCodex(core, bridge, c.c.endpoint);
        void vscode.window.showInformationMessage(
          "已配置 workspace-map MCP。重新加载 Codex MCP 连接后使用。",
        );
        return result;
      }
    }
    if (name === "dsh") {
      const c = await chooseConnection();
      if (!c) return;
      const found = await dshProfiles(core, c.c.endpoint);
      const profile = await vscode.window.showQuickPick(
        found.profiles.map((p: any) => ({ label: p.name, path: p.path })),
        { title: "dsh profile · " + found.launcher },
      );
      if (profile) {
        const result = await connectDsh(
          core,
          bridge,
          c.c.endpoint,
          profile.path,
        );
        void vscode.window.showInformationMessage(
          "已更新 " + profile.label + "，重新加载该 dsh profile 生效。",
        );
        return result;
      }
    }
    if (name === "config") {
      const c = await chooseConnection();
      if (!c) return;
      const doc = await vscode.workspace.openTextDocument({
        language: "json",
        content: JSON.stringify(
          {
            mapId: bridge.mapId,
            session: bridge.id,
            wsl: bridge.config(c.c),
            windows: bridge.config(c.c, true),
          },
          null,
          2,
        ),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  };
  const register = (id: string, run: (...args: any[]) => any) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await run(...args);
        } catch (e) {
          output.error(String(e));
          void vscode.window.showErrorMessage(String(e));
        }
      }),
    );
  register("workspaceMap.open", () => open());
  register("workspaceMap.sidebar", () =>
    vscode.commands.executeCommand("workspaceMap.locations.focus"),
  );
  register("workspaceMap.openLocation", async (ref: Ref) => {
    await core.dispatch("navigate", { ref });
    open();
  });
  for (const [name, direction] of [
    ["back", -1],
    ["forward", 1],
  ] as const)
    register("workspaceMap." + name, async () => {
      await core.dispatch("history", { direction });
      open();
    });
  register("workspaceMap.home", async () => {
    await core.dispatch("navigate");
    open();
  });
  register("workspaceMap.parent", async () => {
    const ref = core.view.root;
    if (ref)
      await core.dispatch("navigate", {
        ref: {
          endpoint: ref.endpoint,
          path: pathApi(core.endpoints.get(ref.endpoint).config).dirname(
            ref.path,
          ),
        },
      });
    open();
  });
  for (const name of ["search", "tasks", "fit"])
    register("workspaceMap." + name, () => {
      pendingAction = name;
      open();
      flushAction();
    });
  register("workspaceMap.addEndpoint", () => commands("add"));
  register("workspaceMap.connectCodex", () => commands("codex"));
  register("workspaceMap.connectDsh", () => commands("dsh"));
  register("workspaceMap.mcpConfig", () => commands("config"));
  register("workspaceMap.logs", () => commands("logs"));
  let cpu = process.cpuUsage();
  let at = performance.now();
  const sampling = new Set<string>();
  const sampleResources = () => {
    const next = process.cpuUsage();
    const now = performance.now();
    const memory = process.memoryUsage();
    profile.record("host.resources", {
      scope: "shared-extension-host",
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
      cpuUserMs: (next.user - cpu.user) / 1000,
      cpuSystemMs: (next.system - cpu.system) / 1000,
      intervalMs: now - at,
      jobs: core.jobs.stats(),
      directories: core.directories.stats(),
    });
    cpu = next;
    at = now;
    for (const [id, e] of core.endpoints.items) {
      if (!e.connected || sampling.has(id)) continue;
      sampling.add(id);
      void e
        .call("resources")
        .then(
          (resources) =>
            profile.record("endpoint.resources", {
              endpoint: id,
              ...resources,
            }),
          (error) =>
            profile.record("endpoint.resources.error", {
              endpoint: id,
              error: String(error),
            }),
        )
        .finally(() => sampling.delete(id));
    }
  };
  let resourceTimer: NodeJS.Timeout | undefined;
  const resourceActivity = () => {
    if (core.jobs.busyCount() && !resourceTimer) {
      resourceTimer = setInterval(sampleResources, 15000);
      resourceTimer.unref();
    } else if (!core.jobs.busyCount() && resourceTimer) {
      clearInterval(resourceTimer);
      resourceTimer = undefined;
    }
  };
  core.jobs.on("change", resourceActivity);
  resourceActivity();
  const monitorSample = () => {
    profile.record("host.resources", {
      scope: "shared-extension-host",
      rss: process.memoryUsage().rss,
      cpu: process.cpuUsage(),
      monitor: core.monitor.stats(),
    });
  };
  core.monitor.on("sample", monitorSample);
  context.subscriptions.push({
    dispose: () => {
      if (resourceTimer) clearInterval(resourceTimer);
      core.jobs.off("change", resourceActivity);
      core.monitor.off("sample", monitorSample);
    },
  });
}
async function addEndpoint(core: Core, config: vscode.WorkspaceConfiguration) {
  const wsls = core.endpoints
    .configs()
    .filter((e) => e.kind === "wsl" || e.kind === "local");
  const transport = await vscode.window.showQuickPick(
    wsls.map((e) => ({ label: e.name, e })),
    { title: "SSH 配置与密钥所在环境" },
  );
  if (!transport) return;
  const sshConfig = await vscode.window.showInputBox({
    title: "OpenSSH 配置绝对路径（留空使用默认配置）",
  });
  if (sshConfig === undefined) return;
  let aliases: string[] = [];
  if (sshConfig) {
    try {
      aliases = await core.endpoints
        .get(transport.e.id)
        .call("sshHosts", { path: sshConfig });
    } catch (e) {
      core.profile.record("ssh.import", { error: String(e) });
    }
  }
  const choice = aliases.length
    ? await vscode.window.showQuickPick([...aliases, "手动输入"], {
        title: "SSH Host",
      })
    : "手动输入";
  if (!choice) return;
  const host =
    choice === "手动输入"
      ? await vscode.window.showInputBox({ title: "SSH 别名或 user@host" })
      : choice;
  if (!host) return;
  if (host.startsWith("-") || /[\r\n]/.test(host))
    throw Error("Invalid SSH host");
  const root = await vscode.window.showInputBox({
    title: "目录根路径",
    value: "/",
  });
  if (!root) return;
  const id =
    "ssh-" +
    host.toLowerCase().replace(/[^a-z0-9_-]/g, "-") +
    "-" +
    randomUUID().slice(0, 6);
  const endpoint: EndpointConfig = {
    id,
    name: host,
    kind: "ssh",
    host,
    root,
    sshConfig: sshConfig || undefined,
    distro: transport.e.distro,
    python: "python3",
  };
  config = vscode.workspace.getConfiguration("workspaceMap");
  const scope = config.inspect<EndpointConfig[]>("endpoints");
  await config.update(
    "endpoints",
    [...(config.get<EndpointConfig[]>("endpoints") ?? []), endpoint],
    scope?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global,
  );
  await core.dispatch("addEndpoint", endpoint);
  return endpoint;
}
export async function deactivate() {
  const a = active;
  active = undefined;
  if (a) {
    const deadline = Date.now() + EXIT_GRACE_MS;
    a.bridge.stopIngress();
    try {
      await a.core.dispose();
    } finally {
      try {
        await a.bridge.dispose(deadline);
      } finally {
        await a.release();
      }
    }
  }
}
