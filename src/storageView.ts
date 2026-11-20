import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Core } from "./core/core";
import { CapacityRefresh } from "./core/capacityRefresh";
import { alias } from "./shared/paths";
import type { Ref } from "./shared/types";

export function createStorageView(
  context: vscode.ExtensionContext,
  core: Core,
): vscode.Disposable {
  let panel: vscode.WebviewPanel | undefined;
  let target: Ref | undefined;
  let ready = false;
  let capacityTarget: Ref | undefined;
  let lastVolume: any;
  const capacity = new CapacityRefresh(
    (ref) => core.storageAnalysis.probe(ref),
    (value) => {
      lastVolume = value;
      if (ready && panel?.visible)
        void panel.webview.postMessage({ type: "capacity", value });
    },
    (error) => {
      if (ready && panel?.visible)
        void panel.webview.postMessage({ type: "capacityError", error });
    },
  );
  const relevant = (job: any) => {
    if (!capacityTarget) return false;
    const input = core.jobs.get(job.id).input;
    const refs: Ref[] = [
      input.ref,
      input.target,
      ...(input.sources ?? []),
      ...(input.refs ?? []),
    ].filter(Boolean);
    if (input.endpoint)
      refs.push({
        endpoint: input.endpoint,
        path: input.cwd ?? core.endpoints.get(input.endpoint).config.root,
      });
    const volume = (ref: Ref) => {
      const c = core.endpoints.get(ref.endpoint).config;
      const id = alias(c, ref.path);
      if (id.startsWith("windows:")) return id.slice(0, 10);
      const host =
        c.kind === "wsl"
          ? (lastVolume?.wsl?.find((w: any) => w.distribution === c.distro)
              ?.hostVolume ??
            (c.distro ===
            core.endpoints.get(capacityTarget!.endpoint).config.distro
              ? lastVolume?.physicalBudget
              : undefined))
          : undefined;
      if (host) return "windows:" + host.mount[0].toLowerCase() + ":";
      return ref.endpoint;
    };
    const selectedConfig = core.endpoints.get(capacityTarget.endpoint).config;
    if (
      job.kind === "package" &&
      selectedConfig.kind === "windows" &&
      refs.some((r) => core.endpoints.get(r.endpoint).config.kind === "windows")
    )
      return true;
    const selected = volume(capacityTarget);
    return refs.some(
      (r) => r.endpoint === capacityTarget!.endpoint || volume(r) === selected,
    );
  };
  const event = (v: any) => {
    if (ready && panel?.visible && v.type === "job" && v.job.kind === "storage")
      void panel.webview.postMessage(v);
    if (
      ready &&
      panel?.visible &&
      v.type === "job" &&
      ["completed", "failed", "cancelled"].includes(v.job.state) &&
      ["storage", "mutation", "transfer", "package"].includes(v.job.kind)
    ) {
      try {
        if (relevant(v.job)) capacity.request();
      } catch {
        /* A retired task has no live input. */
      }
    }
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
            snapshots: await core.storageAnalysis.list(true),
            target,
            jobs: core.jobs
              .active()
              .filter((j) => j.kind === "storage")
              .map((j) => ({ ...j, ref: core.jobs.get(j.id).input.ref })),
          };
        } else if (m.method === "watchCapacity") {
          capacityTarget = m.args.ref;
          capacity.watch(ready && current.visible ? capacityTarget : undefined);
          result = true;
        } else if (m.method === "refreshCapacity") {
          capacity.request();
          result = true;
        } else if (m.method === "locate") {
          await vscode.commands.executeCommand(
            "workspaceMap.openLocation",
            m.args.ref,
          );
          result = true;
        } else if (
          [
            "storageProbe",
            "storageScan",
            "storageResult",
            "storageCompare",
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
      if (!e.webviewPanel.visible) {
        ready = false;
        capacity.watch();
      }
    });
    current.onDidDispose(() => {
      panel = undefined;
      ready = false;
      capacity.watch();
    });
  };
  const command = vscode.commands.registerCommand("workspaceMap.storage", open);
  return {
    dispose() {
      command.dispose();
      core.off("event", event);
      capacity.dispose();
      panel?.dispose();
    },
  };
}
