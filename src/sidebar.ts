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
  tooltip?: string;
};

/** Native navigation only: the editor canvas owns directory reads and watches. */
export function createSidebar(core: Core, mapId: string,
  codexBinding: () => Promise<{ mapId?: string; state: string }>,
): vscode.Disposable {
  const changes = new vscode.EventEmitter<Item | undefined>();
  const groups: Item[] = [
    {
      id: "workspaces",
      label: "收藏",
      icon: "root-folder",
      group: "workspaces",
    },
    {
      id: "machines",
      label: "机器",
      icon: "device-desktop",
      group: "machines",
    },
    { id: "actions", label: "常用操作", icon: "tools", group: "actions" },
    {
      id: "advanced",
      label: "诊断与接入",
      icon: "settings-gear",
      group: "advanced",
    },
  ];
  const actions = [
    ["addFavorite", "添加收藏", "add"],
    ["environment", "当前工作区环境", "tools"],
    ["open", "打开地图", "map"],
    ["home", "全部机器", "home"],
    [
      "search",
      "按名称找文件",
      "search",
      "在当前目录下查找文件或目录名称；点击结果定位或打开",
    ],
    [
      "tasks",
      "传输与后台任务",
      "checklist",
      "查看复制、移动、扫描与安装进度，暂停、继续或取消任务",
    ],
    ["addEndpoint", "添加 SSH 连接", "add"],
    ["resources", "机器资源", "pulse"],
    ["storage", "存储占用", "database"],
  ];
  const advanced = [
    ["importSSH", "导入已有 SSH 配置", "remote"],
    ["bindWindow", "绑定此窗口", "plug", "此窗口的持久地图 ID · " + mapId],
    ["mcpConfig", "MCP 配置", "settings-gear"],
    [
      "logs",
      "诊断日志",
      "output",
      "查看插件运行、连接与耗时日志；整机占用见机器资源",
    ],
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
      if (item.group === "actions" || item.group === "advanced") {
        const binding = item.group === "advanced" ? await codexBinding().catch(() => undefined) : undefined;
        return (item.group === "actions" ? actions : advanced).map(
          ([command, label, icon, tooltip]) => ({
            id: command,
            label,
            icon,
            command: "workspaceMap." + command,
            description: command === "bindWindow" ? "窗口 " + mapId.slice(0, 8) +
              " · Codex " + (binding?.mapId?.slice(0, 8) ?? (binding?.state === "missing" ? "待绑定" : "状态待查")) : undefined,
            tooltip,
          }),
        );
      }
      return [];
    },
    getTreeItem(item) {
      const row = new vscode.TreeItem(
        item.label,
        item.group
          ? item.group === "advanced"
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      row.id = item.id;
      row.contextValue = item.workspaceId
        ? "workspaceMap.favorite"
        : item.id.startsWith("endpoint:") && item.icon === "remote"
          ? "workspaceMap.machine"
          : item.ref
            ? "workspaceMap.directory"
            : undefined;
      row.iconPath = new vscode.ThemeIcon(item.icon);
      row.description = item.description;
      row.tooltip = item.ref
        ? item.ref.endpoint + ": " + item.ref.path
        : (item.tooltip ?? item.label);
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
    if (!["endpoints", "bookmarks", "workspaces", "agentBinding"].includes(event.type)) return;
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
