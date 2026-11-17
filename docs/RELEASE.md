# 构建、安装与回退

仓库：`jiale-li-orion/Wayfarer`，扩展 ID：`orion-workspace.workspace-map`，显示名称：Workspace Map。开发在训练机独立 worktree，本机获取已提交源码镜像及 VSIX 做验收。

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run package
```

Node 22；Linux 使用完整测试集，Windows 执行 `npm run test:portable`，覆盖原生文件 fixture、Windows 路径与命令计划、MCP schema。依赖由 `package-lock.json` 固定。CI 检查与实机验收的覆盖范围分别记录在工作流和 [ACCEPTANCE.md](ACCEPTANCE.md)。

`npm run package` 生成 `artifacts/workspace-map.vsix`、`.vsix.sha256`、`release.json` 与 `RELEASE.md`。元数据包含版本、源码提交、工作区状态、构建时间、字节数及摘要；VSIX 内同时包含 `dist/build-info.json`。GitHub PR 在 Linux／Windows 执行检查并保存构建产物；合并后给该提交打与 package version 对应的 `v*` 标签，Release VSIX 工作流重新构建并发布上述文件。

```sh
# 在通过验收的合并提交上执行
# 示例版本与 package.json 保持一致
git tag v0.2.0
git push github v0.2.0
```

标签发布按仓库权限执行。修改已发布版本时递增版本并创建新标签；每个 Release 与其提交、摘要、机器验收结果对应。Marketplace 另行安排。

在 Windows VS Code 中运行“Extensions: Install from VSIX”，或：

```powershell
& 'D:\Microsoft VS Code\bin\code.cmd' --install-extension '.\workspace-map.vsix' --force
Get-FileHash '.\workspace-map.vsix' -Algorithm SHA256
```

升级前让当前文件操作完成或在任务面板暂停，安装后执行“Developer: Reload Window”。地图按 workspaceState 中的 mapStorageId 恢复：书签、根目录、镜头与展开状态来自 view.json；登记项目与查询快照来自 inspect.json；进行中任务重开后显示为可继续，恢复时沿用传输分片记录。各 VS Code 窗口分别管理会话。

配置继续使用 `workspaceMap.endpoints`、`workspaceMap.pageSize`、`workspaceMap.transferConcurrency`。SSH 的 host、账号、根路径与 sshConfig 由该连接配置和 OpenSSH 管理；自定义管理器和解释器通过包面板指定。MCP 客户端绑定目标窗口会话，Codex／dsh 原有授权策略继续生效。

回退时用目标版本的 VSIX 覆盖安装并重载窗口。保留原 globalStorage：0.1.1 读取原格式的进行中记录；0.2.0 读取 jobs/history 中的完成／取消归档，重新升级后继续展示。完整日志及 input/result 文件仍保留在 jobs 目录。安装与卸载扩展时保留设置与 globalStorage，可延续同一 workspace 的恢复记录。
