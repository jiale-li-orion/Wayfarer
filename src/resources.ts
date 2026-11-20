import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { Core } from "./core/core";
import { pathApi } from "./shared/paths";
import type { FileProvider } from "./filesystem/provider";
import type { Ref } from "./shared/types";

type ResourceOpen = {
  view?: "machine" | "comparison" | "runs" | "job" | "model" | "workloads";
  jobId?: string;
  runId?: string;
  ref?: Ref;
};

export function createResourceView(
  context: vscode.ExtensionContext,
  core: Core,
  provider: FileProvider,
) {
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let selection: ResourceOpen | undefined;
  async function action(m: { method: string; args: any }) {
    let result: any;
    switch (m.method) {
      case "storage":
        result = await vscode.commands.executeCommand("workspaceMap.storage");
        break;
      case "pinMount":{
        const machine=core.monitor.machines().find(x=>x.roots.some(r=>r.endpoint===m.args.endpoint));
        if(!machine)throw Error("未知机器");
        const sample=await core.monitor.snapshot({endpoint:machine.endpoint,section:"comparison"});
        if(!sample.mounts?.some((v:any)=>v.path===m.args.path))throw Error("挂载列表已更新");
        await core.operations.pin(machine.endpoint,m.args.path);
        core.emit("event",{type:"mountPin"});result=true;break;
      }
      case "snapshot":
        result = await core.monitor.snapshot(m.args);
        break;
      case "compare":
        result = await core.dispatch("systemResources", m.args);
        break;
      case "peerPairSave": {
        const pair = m.args.pair;
        const approved =
          m.args.remove === true ||
          (
            await vscode.window.showQuickPick(
              [
                {
                  label: "允许直传",
                  description:
                    pair.source.address + " ↔ " + pair.target.address,
                  allow: true,
                },
                { label: "继续使用 SSH 中转", allow: false },
              ],
              { title: "选择这两台机器的大文件传输方式" },
            )
          )?.allow;
        if (approved) result = await core.dispatch("peerPairSave", m.args);
        break;
      }
      case "fileTransfers":
        await vscode.commands.executeCommand("workspaceMap.tasks");
        break;
      case "openWorkloadFile":
        await vscode.commands.executeCommand(
          "vscode.open",
          provider.uri(m.args.ref),
        );
        break;
      case "workloadsPage":
      case "workloadDetail":
      case "jobsPage":
      case "jobControl":
        result = await core.dispatch(m.method, m.args);
        break;
      case "modelSelection":
        core.setModelSelection(m.args);
        result = true;
        break;
      case "opsCatalog":
      case "opsGroupSave":
      case "opsGroupSelect":
      case "linkInterfaces":
      case "modelAnalysis":
      case "runProfile":
        result = await core.dispatch(m.method, m.args);
        break;
      case "linkProbe":
        result = await core.dispatch("linkProbe", {
          ...m.args,
          operationId: randomUUID(),
        });
        break;
      case "performanceJob":
      case "performanceCancel":
      case "openJobRecord": {
        const job = await core.jobs.details(m.args.id);
        if (!["transfer", "linkProbe"].includes(job.kind))
          throw Error("该任务没有性能报告");
        if (m.method === "performanceCancel") {
          if (job.kind !== "linkProbe") throw Error("请从任务窗口管理文件传输");
          result = core.jobs.control(job.id, "cancel");
        } else if (m.method === "openJobRecord") {
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument({
              language: "json",
              content: JSON.stringify(job, null, 2),
            }),
            { preview: true },
          );
          result = true;
        } else {
          const {
            id,
            kind,
            state,
            bytes,
            progress,
            error,
            result: payload,
          } = job;
          result = {
            id,
            kind,
            state,
            bytes,
            progress,
            error,
            result: payload,
          };
        }
        break;
      }
      case "modelAudio": {
        const ref = m.args.ref as Ref;
        const ep = core.endpoints.get(ref.endpoint);
        const ext = pathApi(ep.config).extname(ref.path).toLowerCase();
        if (
          !pathApi(ep.config).isAbsolute(ref.path) ||
          ![".wav", ".flac", ".mp3", ".ogg"].includes(ext)
        )
          throw Error("请选择音频文件");
        const stat = await ep.call<{ kind: string; size: number }>("stat", {
          path: ref.path,
        });
        if (stat.kind !== "file" || stat.size > 16 * 1024 * 1024)
          throw Error("内置试听上限为 16 MiB");
        const chunks: string[] = [];
        for (let offset = 0; offset < stat.size; offset += 65536) {
          const length = Math.min(65536, stat.size - offset);
          const data = await ep.call<string>("read", {
            path: ref.path,
            offset,
            length,
          });
          if (Buffer.byteLength(data, "base64") !== length)
            throw Error("音频文件已变更");
          chunks.push(data);
        }
        result = {
          chunks,
          type: ext === ".mp3" ? "audio/mpeg" : "audio/" + ext.slice(1),
        };
        break;
      }
      case "openModelSource": {
        const ref = m.args.ref as Ref;
        const ep = core.endpoints.get(ref.endpoint);
        if (!pathApi(ep.config).isAbsolute(ref.path))
          throw Error("源码需要绝对路径");
        const stat = await ep.call<{ kind: string; size: number }>("stat", {
          path: ref.path,
        });
        if (stat.kind !== "file" || stat.size > 1024 * 1024)
          throw Error("源码超出查看范围");
        const document = await vscode.workspace.openTextDocument(
          provider.uri(ref),
        );
        if (
          createHash("sha256").update(document.getText()).digest("hex") !==
          m.args.sha256
        )
          throw Error("当前源码与运行记录版本不同");
        const line = Math.max(
          0,
          Math.min(document.lineCount - 1, Number(m.args.line) - 1 || 0),
        );
        await vscode.window.showTextDocument(document, {
          selection: new vscode.Range(line, 0, line, 0),
          preview: true,
        });
        result = true;
        break;
      }
      case "openPerformanceFile": {
        const ref = m.args.ref as Ref;
        if (
          !pathApi(core.endpoints.get(ref.endpoint).config).isAbsolute(ref.path)
        )
          throw Error("日志路径需要是绝对路径");
        const doc = await vscode.workspace.openTextDocument(provider.uri(ref));
        await vscode.window.showTextDocument(doc, { preview: true });
        result = true;
        break;
      }
      case "locate": {
        const ref = { ...m.args.ref };
        if (m.args.file)
          ref.path = pathApi(core.endpoints.get(ref.endpoint).config).dirname(
            ref.path,
          );
        await vscode.commands.executeCommand("workspaceMap.openLocation", ref);
        result = true;
        break;
      }
      default:
        throw Error("Unknown resource action");
    }
    return result;
  }
  const open = (request?: ResourceOpen) => {
    selection = request?.view ? request : { view: "machine" };
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
      "运行详情",
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
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src blob:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset("resources.css")}"></head><body><div id="root"></div><script nonce="${nonce}" src="${asset("resources.js")}"></script></body></html>`;
    const current = panel;
    current.webview.onDidReceiveMessage(async (m) => {
      if (current !== panel) return;
      try {
        let result: any;
        switch (m.method) {
          case "bootstrap":
            ready = true;
            result = { selection };
            selection = undefined;
            break;
          default:
            result = await action(m);
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
      }
    });
    current.onDidDispose(() => {
      panel = undefined;
      ready = false;
    });
  };
  return {
    open,
    action,
    dispose() {
      panel?.dispose();
    },
  };
}
