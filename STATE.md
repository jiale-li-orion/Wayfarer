# Workspace Map · 0.4.0

训练机主仓库：`/data/users/lijiale/projects/agent-system-learning/workspace-map`；本机镜像与 VSIX：`/home/orion/agent-system-learning/workspace-map`。仓库为 `jiale-li-orion/Wayfarer`，插件显示名称 Workspace Map。开发在训练机独立 worktree，本机安装验收。

## 当前功能与归属

Windows UI Extension Host 持有 Core；目录地图、原生侧边栏、文件编辑器与 MCP 共用文件／任务核心。0.4.0 新增「常用操作 → 机器资源」，四端摘要、进程分页、GPU、磁盘／网络及对象详情按需展开。资源采样拥有独立通道，页面隐藏释放订阅，明确开始的记录持续到停止或地图退出；历史记录支持重开窗口后导出。

NVIDIA 通过 NVML 优先读取，Windows 核显沿 DXGI／PDH；进程名、路径、权限与指标口径保留实际语义。只读 map_systemResources 与界面共享快照，map_resources 保留助手资源职责。源码链路、分组采样与接口见 docs/SYSTEM_RESOURCES.md，整体系统关系见 ARCHITECTURE.md。

0.3.0 的稳定 mapId、operationId 收据、传输暂停原因与续传检查点继续使用。Agent 重连交接视图和任务；旧实例按归属释放资源。资源查看、记录、上传导出和采集器退出分别管理，文件任务沿原 Endpoint／Jobs 通道运行。

## 验证与交付

58 项定向检查、13 项跨平台子集通过；GitHub CI 同时执行 Linux／Windows。实机覆盖 Windows、WSL、训练机 8 张 GPU、推理机 1 张 GPU、实际 Codex／dsh MCP 调用。四端采样与隐藏待机各超过 10 分钟，50 轮真实页签切换后计数归零；原生 JSON／CSV 保存、重开窗口后的 259 条历史导出、双端 8MiB 传输与 SHA-256 回读通过。

资源和响应实测见 PERFORMANCE.md，覆盖与边界见 docs/ACCEPTANCE.md。三级截图已纳入 docs/SYSTEM_RESOURCES.md。PR #6 交付 0.4.0，沿既有 CI／Release 生成 VSIX、SHA-256 与提交元数据；完成后清理独立开发工作树。

## 维护入口

`npm run typecheck`、`npm test`、`npm run test:portable`、`npm run package`。真实资源与生命周期入口为 scripts/verify-resources.mjs；导出和传输脚本在同目录，均限定独立 acceptance-resources 窗口及临时目录。当前生产配置的模型、账号、权限和 SSH 身份沿原设置，升级连接只处理本插件条目。

## 共享环境评审

[日常扩展与资源记录](docs/ENVIRONMENT_AUDIT.md)、[双端资源复核](docs/WINDOWS_WSL_RESOURCE_AUDIT.md)与[Codex／dsh 共享环境评审](docs/SHARED_ENVIRONMENT_REVIEW.md)保留测量条件、工具覆盖和已知限制。评审建议优先验证已有实验 LSP MCP，后续开发按批准范围推进。
