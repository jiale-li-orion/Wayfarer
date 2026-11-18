import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Core } from "./core/core";
import type { Ref } from "./shared/types";

export function createStorageView(
  context: vscode.ExtensionContext,
  core: Core,
): vscode.Disposable {
  let panel: vscode.WebviewPanel | undefined;
  let target: Ref | undefined;
  let ready = false;
  const event = (v: any) => {
    if (ready && panel?.visible && v.type === "job" && v.job.kind === "storage")
      void panel.webview.postMessage(v);
  };
  core.on("event", event);
  const open = (ref?: Ref) => {
    if (ref) target = ref;
    if (panel) {
      panel.reveal();
      if (ready && ref) void panel.webview.postMessage({ type: "target", ref });
      return;
    }
    panel = vscode.window.createWebviewPanel(
      "workspaceMap.storage",
      "存储占用",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );
    panel.iconPath = new vscode.ThemeIcon("database");
    const current = panel;
    const nonce = randomUUID().replaceAll("-", "");
    const asset = (name: string) =>
      current.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", name))
        .toString();
    current.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${current.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset("storage.css")}"></head><body><div id="root"></div><script nonce="${nonce}" src="${asset("storage.js")}"></script></body></html>`;
    current.webview.onDidReceiveMessage(async (m) => {
      try {
        let result: any;
        if (m.method === "bootstrap") {
          ready = true;
          result = {
            endpoints: core.endpoints.configs(),
            snapshots: await core.storageAnalysis.list(),
            target,
            jobs: core.jobs
              .active()
              .filter((j) => j.kind === "storage")
              .map((j) => ({ ...j, ref: core.jobs.get(j.id).input.ref })),
          };
        } else if (m.method === "locate") {
          await vscode.commands.executeCommand(
            "workspaceMap.openLocation",
            m.args.ref,
          );
          result = true;
        } else if (m.method === "export") {
          const uri = await vscode.window.showSaveDialog({
            title: "导出存储分析",
            filters: { JSON: ["json"] },
            defaultUri: vscode.Uri.file(
              path.join(
                vscode.workspace.workspaceFolders?.[0]?.uri.scheme === "file"
                  ? vscode.workspace.workspaceFolders[0].uri.fsPath
                  : core.storage,
                "storage-analysis.json",
              ),
            ),
          });
          if (!uri) result = false;
          else {
            if (uri.scheme !== "file") throw Error("请选择本机导出位置");
            const file = await fs.open(uri.fsPath, "w");
            try {
              let offset = 0,
                first = true;
              while (true) {
                const page = await core.storageAnalysis.query({
                  id: m.args.id,
                  directory: "*",
                  offset,
                  limit: 200,
                });
                if (first)
                  await file.write(
                    '{"snapshot":' +
                      JSON.stringify(page.snapshot) +
                      ',"directories":[\n',
                  );
                for (const row of page.rows) {
                  await file.write((first ? "" : ",\n") + JSON.stringify(row));
                  first = false;
                }
                if (!page.hasMore) break;
                offset += page.rows.length;
              }
              await file.write("\n]}\n");
              result = { path: uri.fsPath };
            } finally {
              await file.close();
            }
          }
        } else if (
          [
            "storageProbe",
            "storageScan",
            "storageResult",
            "storageSnapshots",
            "job",
            "jobControl",
          ].includes(m.method)
        ) {
          result = await core.dispatch(m.method, m.args, "user");
        } else throw Error("Unknown storage view action");
        if (panel === current && current.visible)
          await current.webview.postMessage({ id: m.id, result });
      } catch (error) {
        if (panel === current && current.visible)
          await current.webview.postMessage({ id: m.id, error: String(error) });
      }
    });
    current.onDidChangeViewState((e) => {
      if (!e.webviewPanel.visible) ready = false;
    });
    current.onDidDispose(() => {
      panel = undefined;
      ready = false;
    });
  };
  const command = vscode.commands.registerCommand("workspaceMap.storage", open);
  return {
    dispose() {
      command.dispose();
      core.off("event", event);
      panel?.dispose();
    },
  };
}
