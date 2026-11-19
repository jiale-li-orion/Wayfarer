import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Core } from "./core/core";
import { pathApi } from "./shared/paths";
import { csvRows, csvHeader } from "./core/resourceExport";
import type { FileProvider } from "./filesystem/provider";
import type { Ref } from "./shared/types";

type ResourceOpen = { view?: "machine" | "comparison" | "runs" | "job"; jobId?: string };

export function createResourceView(
  context: vscode.ExtensionContext,
  core: Core,
  provider: FileProvider,
): vscode.Disposable {
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let surfaceVisible = true;
  let query: any = {};
  let compared: string[] = [];
  let recordingFile: string | undefined;
  let selection: ResourceOpen | undefined;
  const owner = "resources:" + randomUUID();
  const sample = (value: any) => {
    if (ready && panel?.visible)
      void panel.webview.postMessage({ type: "sample", value });
  };
  const recordingError = (error: string) => {
    if (panel?.visible)
      void panel.webview.postMessage({ type: "recordingError", error });
  };
  const recordingStopped = (value: any) => {
    recordingFile = value.file;
    if (ready && panel?.visible)
      void panel.webview.postMessage({ type: "recordingStopped", ...value });
  };
  core.monitor.on("recordingStopped", recordingStopped);
  core.monitor.on("sample", sample);
  core.monitor.on("recordingError", recordingError);
  const open = (request?: ResourceOpen) => {
    if (request?.view) selection = request;
    if (panel) {
      panel.reveal();
      if (ready && selection) {
        void panel.webview.postMessage({ type: "open", request: selection });
        selection = undefined;
      }
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
            result = { ...await core.monitor.snapshot(), selection };
            selection = undefined;
            break;
          case "watch":
            query = m.args;
            core.monitor.watch(
              owner,
              current.visible && surfaceVisible ? query : undefined,
            );
            result = true;
            break;
          case "watchComparison":
            compared = m.args.endpoints ?? [];
            core.monitor.retainComparison(owner, current.visible && surfaceVisible ? compared : []);
            result = true;
            break;
          case "visibility":
            surfaceVisible = !!m.args.visible;
            core.monitor.retainComparison(owner, current.visible && surfaceVisible ? compared : []);
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
          case "compare":
            result = await core.dispatch("systemResources", m.args);
            break;
          case "peerPairSave": {
            const pair = m.args.pair;
            const approved = m.args.remove === true || (await vscode.window.showQuickPick([
              { label: "允许直传", description: pair.source.address + " ↔ " + pair.target.address, allow: true },
              { label: "继续使用 SSH 中转", allow: false },
            ], { title: "选择这两台机器的大文件传输方式" }))?.allow;
            if (approved) result = await core.dispatch("peerPairSave", m.args);
            break;
          }
          case "opsCatalog":
          case "opsGroupSave":
          case "opsGroupSelect":
          case "linkInterfaces":
          case "runProfile":
            result = await core.dispatch(m.method, m.args);
            break;
          case "linkProbe":
            result = await core.dispatch("linkProbe", { ...m.args, operationId: randomUUID() });
            break;
          case "performanceJob":
          case "performanceCancel":
          case "openJobRecord": {
            const job = await core.jobs.details(m.args.id);
            if (!["transfer", "linkProbe"].includes(job.kind)) throw Error("该任务没有性能报告");
            if (m.method === "performanceCancel") {
              if (job.kind !== "linkProbe") throw Error("请从任务窗口管理文件传输");
              result = core.jobs.control(job.id, "cancel");
            } else if (m.method === "openJobRecord") {
              await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
                language: "json", content: JSON.stringify(job, null, 2),
              }), { preview: true });
              result = true;
            } else {
              const { id, kind, state, bytes, progress, error, result: payload } = job;
              result = { id, kind, state, bytes, progress, error, result: payload };
            }
            break;
          }
          case "pickProfile": {
            const targets = (await core.monitor.snapshot()).machines as { endpoint: string; name: string; kind: string }[];
            const pick = await vscode.window.showQuickPick([
              { endpoint: "", label: "本机文件…" },
              ...targets.filter((m) => m.kind === "ssh" || m.kind === "wsl")
                .map((m) => ({ endpoint: m.endpoint, label: m.name })),
            ], { title: "选择运行记录所在机器" });
            if (!pick) break;
            let ref: Ref;
            if (pick.endpoint) {
              const file = await vscode.window.showInputBox({
                title: pick.label + " · 运行记录", prompt: "记录文件的绝对路径",
              });
              if (!file) break;
              ref = { endpoint: pick.endpoint, path: file };
            } else {
              const files = await vscode.window.showOpenDialog({
                title: "打开运行记录", canSelectMany: false, filters: { 运行记录: ["json"] },
              });
              if (!files?.[0]) break;
              const file = files[0].fsPath;
              const native = core.endpoints.configs().filter((m) => m.kind === "windows" || m.kind === "local")
                .find((m) => {
                  const paths = pathApi(m);
                  return paths.parse(file).root.toLowerCase() === paths.parse(m.root).root.toLowerCase();
                });
              if (!native) throw Error("找不到此文件所在的本机端点");
              ref = { endpoint: native.id, path: file };
            }
            result = await core.dispatch("runProfile", { ref, remember: true });
            break;
          }
          case "openPerformanceFile": {
            const ref = m.args.ref as Ref;
            if (!pathApi(core.endpoints.get(ref.endpoint).config).isAbsolute(ref.path))
              throw Error("日志路径需要是绝对路径");
            const doc = await vscode.workspace.openTextDocument(provider.uri(ref));
            await vscode.window.showTextDocument(doc, { preview: true });
            result = true;
            break;
          }
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
                    core.monitor.recordingDirectory(),
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
                  core.monitor.recordingDirectory(),
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
        core.monitor.retainComparison(owner, []);
      }
    });
    current.onDidDispose(() => {
      core.monitor.watch(owner, undefined);
      core.monitor.retainComparison(owner, []);
      compared = [];
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
      core.monitor.retainComparison(owner, []);
      core.monitor.off("sample", sample);
      core.monitor.off("recordingStopped", recordingStopped);
      core.monitor.off("recordingError", recordingError);
      panel?.dispose();
    },
  };
}
