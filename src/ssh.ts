import * as vscode from "vscode";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Core } from "./core/core";
import type { EndpointConfig } from "./shared/types";

export function validSshTarget(value: string): string | undefined {
  const match =
    /^([A-Za-z0-9_][A-Za-z0-9_.-]*)@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9_.-]*)(?::([0-9]+))?$/.exec(
      value,
    );
  const port = Number(match?.[3] ?? 22);
  return match && port >= 1 && port <= 65535
    ? undefined
    : "请输入 用户@地址，可加 :端口；IPv6 地址使用方括号";
}

let setup: Promise<EndpointConfig | undefined> | undefined;
export function addSshMachine(
  core: Core,
  helper: string,
  save: (e: EndpointConfig) => Promise<void>,
) {
  return (setup ??= runSshSetup(core, helper, save).finally(() => {
    setup = undefined;
  }));
}

async function runSshSetup(
  core: Core,
  helper: string,
  save: (e: EndpointConfig) => Promise<void>,
) {
  const target = await vscode.window.showInputBox({
    title: "添加机器 · 用户@地址",
    placeHolder: "user@192.168.1.10",
    validateInput: validSshTarget,
    ignoreFocusOut: true,
  });
  if (!target) return;
  const candidates = core.endpoints
    .configs()
    .filter((e) => ["wsl", "local"].includes(e.kind));
  const transport =
    candidates.length === 1
      ? candidates[0]
      : (
          await vscode.window.showQuickPick(
            candidates.map((e) => ({ label: e.name, e })),
            { title: "保存 SSH 凭证的环境" },
          )
        )?.e;
  if (!transport) throw Error("请先添加本机或 WSL 环境");
  const name = await vscode.window.showInputBox({
    title: "机器名称",
    value: target,
    validateInput: (v) =>
      !v.trim() || /[\r\n]/.test(v) || v.length > 80
        ? "请输入 1–80 字符的名称"
        : undefined,
    ignoreFocusOut: true,
  });
  if (!name) return;
  const endpoint = core.endpoints.get(transport.id);
  const info = await endpoint.call("info");
  const source = await fs.readFile(helper);
  const revision = createHash("sha256")
    .update(source)
    .digest("hex")
    .slice(0, 16);
  const folder = path.posix.join(
    info.home,
    ".local/share/workspace-map/ssh-setup",
  );
  const script = path.posix.join(folder, revision + ".py");
  const id = "wayfarer-" + randomUUID();
  const run = path.posix.join(folder, id);
  const resultPath = path.posix.join(run, "result.json");
  await endpoint.call("mkdir", { path: run });
  await endpoint.call("write", {
    path: script,
    data: source.toString("base64"),
    offset: 0,
    truncate: true,
  });
  const args = [
    "-u",
    script,
    "--target",
    target,
    "--alias",
    id,
    "--result",
    resultPath,
  ];
  const terminal = vscode.window.createTerminal({
    name: "首次登录 · " + name,
    isTransient: true,
    shellPath:
      process.platform === "win32" && transport.kind === "wsl"
        ? "wsl.exe"
        : (transport.python ?? "python3"),
    shellArgs:
      process.platform === "win32" && transport.kind === "wsl"
        ? [
            "-d",
            transport.distro!,
            "--exec",
            transport.python ?? "python3",
            ...args,
          ]
        : args,
  });
  let closed = false;
  const closing = vscode.window.onDidCloseTerminal((t) => {
    if (t === terminal) closed = true;
  });
  terminal.show();
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "在 SSH 终端确认主机并输入密码，完成后自动保存机器",
        cancellable: true,
      },
      async (_p, token) => {
        const cancel = token.onCancellationRequested(() => terminal.dispose());
        try {
          for (;;) {
            if (token.isCancellationRequested) throw Error("已取消添加机器");
            let value: any;
            try {
              value = JSON.parse(
                Buffer.from(
                  await endpoint.call("read", {
                    path: resultPath,
                    length: 32768,
                  }),
                  "base64",
                ).toString("utf8"),
              );
            } catch (error: any) {
              if (error?.code !== 2 && error?.type !== "FileNotFoundError")
                throw error;
            }
            if (value) {
              if (value.status !== "completed")
                throw Error(value.error ?? "SSH 登录未完成");
              return value;
            }
            if (closed) throw Error("SSH 终端已关闭；连接尚未保存");
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          cancel.dispose();
        }
      },
    );
    const machine: EndpointConfig = {
      id,
      name: name.trim(),
      kind: "ssh",
      host: result.host,
      sshConfig: result.sshConfig,
      root: result.root,
      python: result.python,
      distro: transport.distro,
    };
    await save(machine);
    await core.dispatch("stat", {
      ref: { endpoint: machine.id, path: machine.root },
    });
    void vscode.window.showInformationMessage(
      "已添加 " + machine.name + "，后续使用专用密钥连接。",
    );
    return machine;
  } finally {
    closing.dispose();
    terminal.dispose();
    await endpoint
      .call("delete", { path: run, recursive: true })
      .catch(() => {});
  }
}
