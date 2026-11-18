import { watch, type FSWatcher } from "node:fs";
import * as vscode from "vscode";
import type { Core } from "./core/core";
import type { Ref } from "./shared/types";

type Item = {
  id: string;
  label: string;
  icon: string;
  group?: string;
  description?: string;
  command?: string;
  ref?: Ref;
  workspaceId?: string;
};

/** Native navigation only: the editor canvas owns directory reads and watches. */
export function createSidebar(core: Core): vscode.Disposable {
  const changes = new vscode.EventEmitter<Item | undefined>();
  const groups: Item[] = [
    {
      id: "workspaces",
      label: "常用工作区",
      icon: "root-folder",
      group: "workspaces",
    },
    {
      id: "machines",
      label: "机器",
      icon: "device-desktop",
      group: "machines",
    },
    { id: "bookmarks", label: "书签", icon: "bookmark", group: "bookmarks" },
    { id: "actions", label: "常用操作", icon: "tools", group: "actions" },
  ];
  const actions = [
    ["favoriteCurrent", "收藏当前工作区", "add"],
    ["favoriteFile", "收藏工作区文件", "file-code"],
    ["environment", "当前工作区环境", "tools"],
    ["open", "打开地图", "map"],
    ["home", "全部机器", "home"],
    ["search", "搜索当前子树", "search"],
    ["tasks", "后台任务", "checklist"],
    ["addEndpoint", "添加 SSH 连接", "add"],
    ["connectCodex", "接入 Codex", "plug"],
    ["connectDsh", "接入 dsh", "plug"],
    ["mcpConfig", "MCP 配置", "settings-gear"],
    ["resources", "机器资源", "pulse"],
    ["logs", "性能日志", "output"],
  ];
  const provider: vscode.TreeDataProvider<Item> = {
    onDidChangeTreeData: changes.event,
    async getChildren(item) {
      if (!item) return groups;
      if (item.group === "workspaces")
        return ((await core.workspaceStore?.list()) ?? []).map((w) => ({
          id: "workspace:" + w.id,
          workspaceId: w.id,
          label: w.name,
          icon: "root-folder",
          description: w.locations[0]?.endpoint.name ?? w.uri,
          command: "workspaceMap.openWorkspace",
        }));
      if (item.group === "machines")
        return core.endpoints.configs().map((e) => ({
          id: "endpoint:" + e.id,
          label: e.name,
          icon:
            e.kind === "ssh"
              ? "remote"
              : e.kind === "wsl"
                ? "terminal-linux"
                : "device-desktop",
          description: e.root,
          ref: { endpoint: e.id, path: e.root },
        }));
      if (item.group === "bookmarks")
        return core.view.bookmarks.map((ref) => ({
          id: "bookmark:" + JSON.stringify(ref),
          label: ref.path,
          icon: "bookmark",
          description:
            core.endpoints.configs().find((e) => e.id === ref.endpoint)?.name ??
            ref.endpoint,
          ref,
        }));
      if (item.group === "actions")
        return actions.map(([command, label, icon]) => ({
          id: command,
          label,
          icon,
          command: "workspaceMap." + command,
        }));
      return [];
    },
    getTreeItem(item) {
      const row = new vscode.TreeItem(
        item.label,
        item.group
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      row.id = item.id;
      row.contextValue = item.workspaceId
        ? "workspaceMap.favorite"
        : item.ref
          ? "workspaceMap.directory"
          : undefined;
      row.iconPath = new vscode.ThemeIcon(item.icon);
      row.description = item.description;
      row.tooltip = item.ref
        ? item.ref.endpoint + ": " + item.ref.path
        : item.label;
      if (!item.group)
        row.command = {
          command: item.ref ? "workspaceMap.openLocation" : item.command!,
          title: item.label,
          arguments: item.workspaceId
            ? [item.workspaceId]
            : item.ref
              ? [item.ref]
              : [],
        };
      return row;
    },
  };
  const tree = vscode.window.createTreeView("workspaceMap.locations", {
    treeDataProvider: provider,
  });
  let dirty = false;
  const update = (event: { type: string }) => {
    if (!["endpoints", "bookmarks", "workspaces"].includes(event.type)) return;
    if (tree.visible) changes.fire(undefined);
    else dirty = true;
  };
  core.on("event", update);
  let watcher: FSWatcher | undefined;
  const syncWatch = () => {
    watcher?.close();
    watcher = undefined;
    if (tree.visible && core.workspaceStore) {
      try {
        watcher = watch(core.workspaceStore.directory, (_event, name) => {
          if (name?.toString() === "workspaces.json") changes.fire(undefined);
        });
      } catch {}
      changes.fire(undefined);
    }
  };
  core.workspaceUiStats = () => ({
    catalogWatchers: watcher ? 1 : 0,
    visible: tree.visible,
  });
  syncWatch();
  const visible = tree.onDidChangeVisibility(() => {
    syncWatch();
    if (tree.visible && dirty) {
      dirty = false;
      changes.fire(undefined);
    }
  });
  return {
    dispose() {
      core.workspaceUiStats = undefined;
      watcher?.close();
      core.off("event", update);
      visible.dispose();
      tree.dispose();
      changes.dispose();
    },
  };
}
