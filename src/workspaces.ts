import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { Core } from "./core/core";
import {
  WorkspaceStore,
  parseWorkspaceRoots,
  type SavedWorkspace,
} from "./core/workspaces";
import type { Ref, EndpointConfig } from "./shared/types";
const sameConnection = (a: EndpointConfig, b: EndpointConfig) =>
  a.kind === b.kind &&
  a.host === b.host &&
  a.distro === b.distro &&
  a.sshConfig === b.sshConfig &&
  (a.kind !== "windows" || a.root.toLowerCase() === b.root.toLowerCase());
export function nativeRef(core: Core, uri: vscode.Uri): Ref | undefined {
  if (uri.scheme === "workspacemap" || uri.scheme === "workspacemap-win")
    return {
      endpoint: uri.authority,
      path: uri.scheme.endsWith("-win")
        ? uri.path.slice(1).replaceAll("/", "\\")
        : uri.path,
    };
  const configs = core.endpoints.configs();
  if (uri.scheme === "file") {
    const p = uri.fsPath;
    const e =
      configs.find(
        (e) =>
          e.kind === "windows" &&
          p.toLowerCase().startsWith(e.root.toLowerCase()),
      ) ?? configs.find((e) => e.kind === "local");
    return e ? { endpoint: e.id, path: p } : undefined;
  }
  if (uri.scheme === "vscode-remote") {
    const [type, ...rest] = uri.authority.split("+");
    const host = rest.join("+");
    const e = configs.find((e) =>
      type === "wsl"
        ? e.kind === "wsl" && e.distro?.toLowerCase() === host.toLowerCase()
        : type === "ssh-remote" && e.kind === "ssh" && e.host === host,
    );
    if (e) return { endpoint: e.id, path: uri.path };
  }
}
export function nativeUri(core: Core, ref: Ref) {
  const e = core.endpoints.get(ref.endpoint).config;
  if (e.kind === "windows" || e.kind === "local")
    return vscode.Uri.file(ref.path);
  if (e.kind === "wsl")
    return vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "wsl+" + e.distro,
      path: ref.path,
    });
  // WSL's SSH config may differ from Windows Remote SSH. Bind an existing native authority explicitly.
  return undefined;
}
export function resolveLocations(core: Core, item: SavedWorkspace): Ref[] {
  return item.locations.map(({ ref, endpoint }) => {
    let config = core.endpoints
      .configs()
      .find((e) => sameConnection(e, endpoint));
    if (!config) {
      config = {
        ...endpoint,
        id:
          "favorite-" +
          createHash("sha256")
            .update(JSON.stringify(endpoint))
            .digest("hex")
            .slice(0, 12),
      };
      core.endpoints.add(config);
    }
    return { ...ref, endpoint: config.id };
  });
}
export function createWorkspaceCommands(
  context: vscode.ExtensionContext,
  core: Core,
): vscode.Disposable {
  const store = (core.workspaceStore = new WorkspaceStore(
    context.globalStorageUri.fsPath,
  ));
  const change = () => core.emit("event", { type: "workspaces" });
  const migrated = (async () => {
    const remaining: Ref[] = [];
    for (const ref of core.view.bookmarks) {
      try {
        const endpoint = core.endpoints.get(ref.endpoint).config;
        const uri = nativeUri(core, ref)?.toString();
        await store.importLocation({
          name:
            ref.path
              .replace(/[\\/]$/, "")
              .split(/[\\/]/)
              .pop() || ref.path,
          uri,
          locations: [{ ref, endpoint }],
        });
      } catch {
        remaining.push(ref);
      }
    }
    if (remaining.length !== core.view.bookmarks.length)
      await core.dispatch("setView", { bookmarks: remaining });
    change();
  })();
  void migrated.catch((error) =>
    core.profile.record("favorites.migration", { error: String(error) }),
  );
  const get = async (arg?: any) => {
    const id = typeof arg === "string" ? arg : arg?.workspaceId;
    const item = (await store.list()).find((x) => x.id === id);
    if (!item) throw Error("工作区收藏已移除");
    return item;
  };
  const locations = (uris: readonly vscode.Uri[]) =>
    uris.flatMap((uri) => {
      const ref = nativeRef(core, uri);
      return ref
        ? [{ ref, endpoint: core.endpoints.get(ref.endpoint).config }]
        : [];
    });
  const save = async (
    uri: vscode.Uri | undefined,
    refs: Ref[],
    defaultName: string,
  ) => {
    const name = await vscode.window.showInputBox({
      title: "收藏",
      value: defaultName,
    });
    if (!name?.trim()) return;
    await store.save({
      name,
      uri: uri?.toString(),
      locations: refs.map((ref) => ({
        ref,
        endpoint: core.endpoints.get(ref.endpoint).config,
      })),
    });
    change();
  };
  const bind = async (item: SavedWorkspace) => {
    const nativeRemote = vscode.workspace.workspaceFolders?.find(
      (f) => f.uri.scheme === "vscode-remote",
    )?.uri.authority;
    const authority = await vscode.window.showInputBox({
      title: "绑定已配置的原生 Remote 目标",
      prompt: "例如 ssh-remote+train；使用 VS Code Remote SSH 已配置的 Host",
      value:
        nativeRemote ??
        "ssh-remote+" + (item.locations[0]?.endpoint.host ?? ""),
    });
    if (!authority) return;
    if (!/^(ssh-remote|wsl)\+[^/\s]+$/.test(authority))
      throw Error("填写有效 Remote authority");
    const target = item.locations[0]?.ref.path;
    if (!target) throw Error("收藏缺少目标路径");
    const uri = vscode.Uri.from({
      scheme: "vscode-remote",
      authority,
      path: target,
    });
    await store.update(item.id, { uri: uri.toString() });
    change();
    return uri;
  };
  const open = async (arg: any, newWindow = false) => {
    const item = await get(arg);
    if (!item.uri) {
      const roots = resolveLocations(core, item);
      if (roots[0]) {
        await vscode.commands.executeCommand(
          "workspaceMap.openLocation",
          roots[0],
        );
        return;
      }
    }
    const uri = item.uri ? vscode.Uri.parse(item.uri) : await bind(item);
    if (!uri) return;
    const normalize = (u: vscode.Uri) =>
      u.scheme === "file" && process.platform === "win32"
        ? u.toString().toLowerCase()
        : u.toString();
    const current =
      vscode.workspace.workspaceFile ??
      (vscode.workspace.workspaceFolders?.length === 1
        ? vscode.workspace.workspaceFolders[0].uri
        : undefined);
    if (!newWindow && current && normalize(current) === normalize(uri)) {
      await vscode.commands.executeCommand("workbench.view.explorer");
      return;
    }
    if (uri.scheme === "file") await vscode.workspace.fs.stat(uri);
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      uri,
      newWindow ? { forceNewWindow: true } : {},
    );
  };
  const rootsFor = async (item: SavedWorkspace): Promise<Ref[]> => {
    let roots = resolveLocations(core, item);
    if (item.uri) {
      const uri = vscode.Uri.parse(item.uri);
      if (uri.path.endsWith(".code-workspace")) {
        const document = await vscode.workspace.openTextDocument(uri);
        roots = [];
        for (const target of parseWorkspaceRoots(
          uri.toString(),
          document.getText(),
        )) {
          const ref = nativeRef(core, vscode.Uri.parse(target));
          if (ref) roots.push(ref);
        }
      } else {
        const ref = nativeRef(core, uri);
        if (ref) roots = [ref];
      }
    }
    if (!roots.length)
      throw Error("当前地图尚未配置该工作区的文件端点；添加对应机器后查看");
    return roots;
  };
  const definitions: Record<string, (...args: any[]) => any> = {
    favorites: async () => {
      await migrated;
      const items = await store.list();
      const chosen = await vscode.window.showQuickPick(
        items.map((w) => ({
          label: w.name,
          description: w.locations[0]?.ref.path ?? w.uri,
          id: w.id,
        })),
        {
          title: "收藏",
          placeHolder:
            "选择收藏；项目在 VS Code 打开，未绑定的远端目录在地图定位",
        },
      );
      if (chosen) await open(chosen.id);
    },
    addFavorite: async () => {
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: "当前工作区",
            description: "保存当前项目或多根工作区",
            command: "favoriteCurrent",
          },
          {
            label: "已有 .code-workspace 文件",
            description: "选择已保存的工作区配置",
            command: "favoriteFile",
          },
          {
            label: "已登记的项目目录",
            description: "选择地图中登记过的项目",
            command: "favoriteDirectory",
          },
        ],
        { title: "添加收藏" },
      );
      if (picked)
        await vscode.commands.executeCommand("workspaceMap." + picked.command);
    },
    favoriteCurrent: async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const uri =
        vscode.workspace.workspaceFile ??
        (folders.length === 1 ? folders[0].uri : undefined);
      const roots = locations(folders.map((f) => f.uri));
      if (!uri || uri.scheme === "untitled") {
        await vscode.commands.executeCommand(
          "workbench.action.saveWorkspaceAs",
        );
        return;
      }
      await save(
        uri,
        roots.map((l) => l.ref),
        vscode.workspace.name ?? "工作区",
      );
    },
    favoriteFile: async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "VS Code Workspace": ["code-workspace"] },
        title: "收藏工作区文件",
      });
      if (!selected?.[0]) return;
      const uri = selected[0];
      await save(
        uri,
        [],
        uri.path
          .split("/")
          .pop()!
          .replace(/\.code-workspace$/, ""),
      );
    },
    favoriteDirectory: async (arg?: any) => {
      let ref: Ref | undefined =
        arg?.ref ??
        (arg?.endpoint
          ? arg
          : arg instanceof vscode.Uri
            ? nativeRef(core, arg)
            : undefined);
      if (!ref) {
        const options = core.inspector
          .projects()
          .map((r) => ({ label: r.path, description: r.endpoint, ref: r }));
        const selected = await vscode.window.showQuickPick(options, {
          title: "收藏已登记项目",
        });
        ref = selected?.ref;
      }
      if (!ref) return;
      const s = await core.dispatch("stat", { ref });
      if (s.kind !== "directory") throw Error("选择项目目录");
      await save(
        nativeUri(core, ref),
        [ref],
        ref.path
          .replace(/[\\/]$/, "")
          .split(/[\\/]/)
          .pop() ?? ref.path,
      );
    },
    openWorkspace: (arg) => open(arg),
    openWorkspaceNew: (arg) => open(arg, true),
    bindWorkspace: async (arg) => bind(await get(arg)),
    renameWorkspace: async (arg) => {
      const item = await get(arg);
      const name = await vscode.window.showInputBox({
        title: "工作区名称",
        value: item.name,
      });
      if (name) {
        await store.update(item.id, { name });
        change();
      }
    },
    removeWorkspace: async (arg) => {
      await store.update((await get(arg)).id, { remove: true });
      change();
    },
    workspaceUp: async (arg) => {
      await store.update((await get(arg)).id, { direction: "up" });
      change();
    },
    workspaceDown: async (arg) => {
      await store.update((await get(arg)).id, { direction: "down" });
      change();
    },
    locateWorkspace: async (arg) => {
      const roots = await rootsFor(await get(arg));
      if (!roots.length) throw Error("使用查看环境读取工作区根目录");
      await vscode.commands.executeCommand(
        "workspaceMap.openLocation",
        roots[0],
      );
    },
    addWorkspaceFolder: async (arg) => {
      const item = await get(arg),
        uri = item.uri ? vscode.Uri.parse(item.uri) : await bind(item);
      if (!uri) return;
      if (uri.path.endsWith(".code-workspace"))
        throw Error("选择具体目录后加入当前工作区");
      const current = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (
        current &&
        (uri.scheme !== current.scheme || uri.authority !== current.authority)
      )
        throw Error("目标属于另一个运行环境；请原生打开或在地图中浏览");
      if (
        vscode.workspace.workspaceFolders?.some(
          (f) => f.uri.toString() === uri.toString(),
        )
      )
        return;
      if (
        !vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri },
        )
      )
        throw Error("VS Code 未接受工作区变更");
    },
    workspaceEnvironment: async (arg) => {
      await vscode.commands.executeCommand(
        "workspaceMap.environment",
        await rootsFor(await get(arg)),
      );
    },
  };
  const disposables = Object.entries(definitions).map(([id, run]) =>
    vscode.commands.registerCommand("workspaceMap." + id, async (...args) => {
      try {
        return await run(...args);
      } catch (e) {
        void vscode.window.showErrorMessage(String(e));
      }
    }),
  );
  return {
    dispose() {
      disposables.forEach((d) => d.dispose());
      core.workspaceStore = undefined;
    },
  };
}
