import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { Core } from "./core/core";
import type { Ref } from "./shared/types";
import type { FileProvider } from "./filesystem/provider";
import { nativeRef } from "./workspaces";
export function createEnvironmentView(
  context: vscode.ExtensionContext,
  core: Core,
  provider: FileProvider,
): vscode.Disposable {
  const panels = new Map<string, vscode.WebviewPanel>();
  core.environmentUiStats = () => ({ panels: panels.size });
  const command = vscode.commands.registerCommand(
    "workspaceMap.environment",
    async (input?: Ref[] | Ref) => {
      const roots = Array.isArray(input)
        ? input
        : input
          ? [input]
          : (vscode.workspace.workspaceFolders ?? []).flatMap((f) => {
              const ref = nativeRef(core, f.uri);
              return ref ? [ref] : [];
            });
      if (!roots.length) {
        void vscode.window.showInformationMessage(
          "选择地图目录或配置当前工作区的文件端点",
        );
        return;
      }
      const key = JSON.stringify(roots);
      const existing = panels.get(key);
      if (existing) {
        existing.reveal();
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "workspaceMap.environment",
        "项目环境",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
          ],
        },
      );
      panels.set(key, panel);
      let subscribed = false;
      const nonce = randomUUID().replaceAll("-", "");
      const asset = (name: string) =>
        panel.webview
          .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", name))
          .toString();
      panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset("environment.css")}"></head><body><div id="root"></div><script nonce="${nonce}" src="${asset("environment.js")}"></script></body></html>`;
      const event = (e: any) => {
        if (subscribed && panel.visible && e.type === "job")
          void panel.webview.postMessage(e);
      };
      core.on("event", event);
      const receiver = panel.webview.onDidReceiveMessage(async (m) => {
        try {
          let result: any;
          if (m.method === "bootstrap") result = { roots };
          else if (m.method === "textInputFocus") {
            result = await vscode.commands.executeCommand(
              "setContext",
              "workspaceMap.textInputFocus",
              !!m.args.focused && panel.active,
            );
          } else if (m.method === "jobSubscription") {
            subscribed = !!m.args.enabled;
            result = true;
          } else if (m.method === "locate")
            result = await vscode.commands.executeCommand(
              "workspaceMap.openLocation",
              m.args.ref,
            );
          else if (m.method === "open")
            result = await vscode.commands.executeCommand(
              "vscode.open",
              provider.uri(m.args.ref),
            );
          else if (
            [
              "inspect",
              "environmentSelect",
              "inventory",
              "packageDiscover",
              "packagePlan",
              "package",
              "job",
              "jobControl",
              "size",
            ].includes(m.method)
          )
            result = await core.dispatch(m.method, m.args);
          else throw Error("Unknown project environment action");
          await panel.webview.postMessage({ id: m.id, result });
        } catch (e) {
          await panel.webview.postMessage({ id: m.id, error: String(e) });
        }
      });
      panel.onDidChangeViewState(() => {
        if (!panel.visible) subscribed = false;
        if (!panel.active)
          void vscode.commands.executeCommand(
            "setContext",
            "workspaceMap.textInputFocus",
            false,
          );
      });
      panel.onDidDispose(() => {
        receiver.dispose();
        core.off("event", event);
        panels.delete(key);
      });
    },
  );
  return {
    dispose() {
      core.environmentUiStats = undefined;
      command.dispose();
      for (const panel of panels.values()) panel.dispose();
    },
  };
}
