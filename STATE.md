# Workspace Map · 0.5.0 开发验收

训练机主仓库 `/data/users/lijiale/projects/agent-system-learning/workspace-map`；独立工作树 `/data/users/lijiale/worktrees/workspace-map-0.5.0`，分支 `feat/workspaces-environments`。本机镜像用于安装验收。Windows 验收资料位于 D:\Wayfarer-Acceptance，构建与依赖安装均在训练机。

## 当前行为

常用工作区使用 globalStorage 全局收藏，原生打开由 Windows UI 宿主调用；地图、任务与 Agent 继续按 mapId 归属。项目环境页从常用工作区和目录详情进入，多根目录独立切换。Inspector 解析有限声明和明确执行选择，真实版本、安装清单、缓存与占用按需查询。Python 默认 uv；项目声明和锁文件变更与环境同步分开执行，现有虚拟环境为操作目标。

共享文件、任务、恢复、机器资源链路继续沿原 Core；工作区收藏与面板分别释放监听／订阅。固定项目标记和工具路径改为批量查询。具体关系见 ARCHITECTURE.md 与 docs/PROJECT_ENVIRONMENTS.md。

## 当前验证与剩余

65 项检查和类型检查通过，uv 0.9.22 隔离 wheel 的添加、同步、更新、移除通过。100 次同机本地冷查询：0.4.0 每次 46 次适配器调用，0.5.0 为 4 次；中位耗时 0.980→0.634ms。缓存查询保持零适配器访问。Windows D 盘独立验收窗口正在完成待机、页面与四端查询验收，正式发布记录在完成后补入。

用户补充：PR #5 冲突需解决并合并。已完成三份文档冲突处理，双平台 CI 通过，合入 main `f07f41f`；分支和临时工作树已清理。C 盘曾接近满盘，本轮自有 C 盘验收目录 27MiB 已删除，端点异常小日志留存 D 盘；WSL 虚拟盘约 286GiB，昨晚增长原因仍待独立排查。

## 下一步

完成 Windows／WSL／两台 SSH 的环境读取、原生收藏入口、50 轮页面资源回收及 MCP 回归；记录 CPU／内存与截图，核对依赖和构建，再提交单一 PR、交付 VSIX。交付后同步镜像并清理独立工作树。
