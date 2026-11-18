import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Core } from "./core/core";
import { pathApi } from "./shared/paths";
import { csvRows, csvHeader } from "./core/resourceExport";

export function createResourceView(
  context: vscode.ExtensionContext,
  core: Core,
): vscode.Disposable {
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let surfaceVisible = true;
  let query: any = {};
  let recordingFile: string | undefined;
  const owner = "resources:" + randomUUID();
  const sample = (value: any) => {
    if (ready && panel?.visible)
      void panel.webview.postMessage({ type: "sample", value });
  };
  const recordingError = (error: string) => {
    if (panel?.visible)
      void panel.webview.postMessage({ type: "recordingError", error });
  };
  core.monitor.on("sample", sample);
  core.monitor.on("recordingError", recordingError);
  const open = () => {
    if (panel) {
      panel.reveal();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      "workspaceMap.resources",
      "机器资源",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );
    panel.iconPath = new vscode.ThemeIcon("pulse");
    const nonce = randomUUID().replaceAll("-", "");
    const asset = (name: string) =>
      panel!.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", name))
        .toString();
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset("resources.css")}"></head><body><div id="root"></div><script nonce="${nonce}" src="${asset("resources.js")}"></script></body></html>`;
    const current = panel;
    current.webview.onDidReceiveMessage(async (m) => {
      try {
        let result: any;
        switch (m.method) {
          case "bootstrap":
            ready = true;
            surfaceVisible = m.args?.visible !== false;
            result = await core.monitor.snapshot();
            break;
          case "watch":
            query = m.args;
            core.monitor.watch(
              owner,
              current.visible && surfaceVisible ? query : undefined,
            );
            result = true;
            break;
          case "visibility":
            surfaceVisible = !!m.args.visible;
            core.monitor.watch(
              owner,
              current.visible && surfaceVisible ? query : undefined,
            );
            result = true;
            break;
          case "storage":
            result = await vscode.commands.executeCommand(
              "workspaceMap.storage",
            );
            break;
          case "snapshot":
            result = await core.monitor.snapshot(m.args);
            break;
          case "record":
            if (m.args.start) {
              result = await core.monitor.startRecording();
              recordingFile = result.file;
            } else {
              result = await core.monitor.stopRecording();
              recordingFile = result?.file ?? recordingFile;
            }
            break;
          case "locate": {
            const ref = { ...m.args.ref };
            if (m.args.file)
              ref.path = pathApi(
                core.endpoints.get(ref.endpoint).config,
              ).dirname(ref.path);
            await vscode.commands.executeCommand(
              "workspaceMap.openLocation",
              ref,
            );
            result = true;
            break;
          }
          case "export": {
            let source: string | undefined;
            let format = m.args.format === "csv" ? "csv" : "json";
            if (m.args.recording) {
              const choice = recordingFile
                ? await vscode.window.showQuickPick(
                    ["本次记录", "选择历史记录…"],
                    { title: "导出资源记录" },
                  )
                : "选择历史记录…";
              if (!choice) {
                result = false;
                break;
              }
              if (choice === "本次记录") source = recordingFile;
              else {
                const files = await vscode.window.showOpenDialog({
                  title: "选择此地图的资源记录",
                  defaultUri: vscode.Uri.file(
                    path.join(core.storage, "resource-recordings"),
                  ),
                  canSelectFiles: true,
                  canSelectFolders: false,
                  canSelectMany: false,
                  filters: { 资源记录: ["jsonl"] },
                });
                if (!files?.[0]) {
                  result = false;
                  break;
                }
                source = files[0].fsPath;
              }
              const selection = await vscode.window.showQuickPick(
                ["JSON", "CSV"],
                { title: "导出格式" },
              );
              if (!selection) {
                result = false;
                break;
              }
              format = selection === "CSV" ? "csv" : "json";
            }
            const uri = await vscode.window.showSaveDialog({
              title: "导出资源记录",
              defaultUri: vscode.Uri.file(
                path.join(
                  os.homedir(),
                  "workspace-resources-" +
                    new Date().toISOString().replace(/[:.]/g, "-") +
                    "." +
                    format,
                ),
              ),
              filters: format === "csv" ? { CSV: ["csv"] } : { JSON: ["json"] },
            });
            if (!uri) {
              result = false;
              break;
            }
            if (uri.scheme !== "file") throw Error("请选择本机导出位置");
            const target = await fs.open(uri.fsPath, "w");
            try {
              let first = true;
              await target.write(format === "csv" ? csvHeader : "[\n");
              if (source) {
                const input = await core.monitor.readRecording(source);
                try {
                  for await (const line of input.lines) {
                    if (!line.trim()) continue;
                    const value = JSON.parse(line);
                    await target.write(
                      format === "csv"
                        ? csvRows(value)
                        : (first ? "" : ",\n") + JSON.stringify(value),
                    );
                    first = false;
                  }
                } finally {
                  input.lines.close();
                  input.stream.destroy();
                }
              } else {
                const state = await core.monitor.snapshot();
                for (const value of state.snapshots) {
                  await target.write(
                    format === "csv"
                      ? csvRows(value)
                      : (first ? "" : ",\n") + JSON.stringify(value),
                  );
                  first = false;
                }
              }
              if (format === "json") await target.write("\n]\n");
            } finally {
              await target.close();
            }
            result = { path: uri.fsPath };
            break;
          }
          default:
            throw Error("Unknown resource view action");
        }
        if (panel === current && current.visible)
          await current.webview.postMessage({ id: m.id, result });
      } catch (error) {
        if (panel === current && current.visible)
          await current.webview.postMessage({ id: m.id, error: String(error) });
      }
    });
    current.onDidChangeViewState((e) => {
      if (!e.webviewPanel.visible) {
        ready = false;
        core.monitor.watch(owner, undefined);
      }
    });
    current.onDidDispose(() => {
      core.monitor.watch(owner, undefined);
      panel = undefined;
      ready = false;
    });
  };
  const command = vscode.commands.registerCommand(
    "workspaceMap.resources",
    open,
  );
  return {
    dispose() {
      command.dispose();
      core.monitor.watch(owner, undefined);
      core.monitor.off("sample", sample);
      core.monitor.off("recordingError", recordingError);
      panel?.dispose();
    },
  };
}
