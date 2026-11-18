# Workspace Map · 0.5.0

训练机主仓库：`/data/users/lijiale/projects/agent-system-learning/workspace-map`；本机镜像：`/home/orion/agent-system-learning/workspace-map`。仓库 `jiale-li-orion/Wayfarer`，显示名称 Workspace Map。开发使用训练机独立 worktree，本机负责安装与实机验收；验收产物位于 D:\Wayfarer-Acceptance，构建与依赖安装留在训练机。

## 当前功能与归属

常用工作区在 globalStorage 共享收藏，原生打开由 Windows UI 宿主调度；地图、任务与 Agent 继续归各自 mapId。收藏支持目录／工作区文件、原生打开、加入当前工作区、地图定位、环境查看、重命名及排序。SSH 原生入口显式绑定既有 Remote 配置。

项目环境按根目录查看声明、解释器、工具版本、依赖与占用。Python 默认 uv；清单／锁文件修改与已有环境同步分开执行，明确选择的解释器与 Node 运行时只影响 Wayfarer 操作。Java 缓存位置与统计结果标明路径、来源和时间。版本查询与统计均按需，面板关闭释放订阅，后台任务独立执行。

固定项目标记、工具路径批量读取；快照有界、同请求合并、修改后失效。收藏监听随侧边栏可见性释放，诊断包含环境面板与收藏监听计数。文件、传输、恢复、机器资源及原账号配置沿原核心。详见 ARCHITECTURE.md 与 docs/PROJECT_ENVIRONMENTS.md。

## 验证与交付

71 项检查、类型检查及 Python 3.6 助手语法检查通过。Windows／WSL／两台 SSH 的环境与工具读取、51 轮环境页面打开／关闭、实际 Codex／dsh MCP 查询、原生多根添加／工作区切换／收藏保留／当前工作区聚焦通过。工作区文件 JSONC 解析按 CommonJS 打包产物和实机双重验证。uv 隔离 wheel 的增删、锁定更新、同步、导入与移除验证通过。原生远端 IDE 与额外新窗口的实机覆盖边界见 docs/ACCEPTANCE.md。

相同原生目录冷查询适配器调用 46→4，p50 0.980→0.634ms；缓存保持零端点访问。同一独立窗口约 615／619 秒待机，0.4／0.5 共享扩展宿主单核 CPU 0.0229%／0.0808%，结束 heapUsed 42.17／42.47MiB，pending 和运行任务均为零。进程工作集、私有提交量及测量条件分别保留，见 PERFORMANCE.md 与 docs/performance-data/environments-20261118。

PR #5 环境评审已解决冲突并合入 main f07f41f，临时工作树与分支已清理。PR #7 交付本轮，沿 CI／Release 发布 v0.5.0、VSIX、SHA-256 与源码身份。Windows 日常窗口通过重载启用安装的新版本；MCP 继续绑定原稳定 mapId。

## 维护入口

`npm run typecheck`、`npm test`、`npm run test:portable`、`npm run package`。环境与工作区验收脚本为 scripts/verify-environments-live.mjs、verify-uv-project.mjs、profile-environments.mjs；真实文件与软件修改使用独立 fixture。交付后同步主仓库、本机镜像并清理开发工作树，最终证据与发布文件留在 D 盘。
