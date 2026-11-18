# Workspace Map · 0.6.0

训练机主仓库 /data/users/lijiale/projects/agent-system-learning/workspace-map；本机镜像 /home/orion/agent-system-learning/workspace-map。仓库 jiale-li-orion/Wayfarer，显示名称 Workspace Map。训练机独立工作树开发，本机安装验收，产物留 D 盘。

## 本轮

存储占用页面复用侧边栏、资源页和目录详情入口。后台扫描使用独立 Python 通道与 SQLite 目录索引，按卷串行、全局至多两个；逻辑大小、实际分配和硬链接共享分别展示。Windows 关联 WSL 承载 VHD 与交换文件，WSL /mnt 入口与 Windows 按卷关联。界面与 MCP 共享结果、分页、下钻、取消与快照保留，原 size 保持兼容。接口、口径及生命周期见 docs/STORAGE.md 与 ARCHITECTURE.md。

任务详情可选择字段，客户端可显式关闭自己的目录游标；pip 缓存管理补齐。损坏协议立即拒绝该通道的请求并关闭所属进程。

实际四端扫描、50 轮页面开关、十分钟待机与百万文件扫描已核对，数据见 PERFORMANCE.md 和 docs/performance-data/storage-20261118。源码沿 CI/Release 交付 0.6.0 VSIX、摘要和版本身份；本机日常窗口重载后启用新版本。

## C 盘维护

已整理实际管理器缓存与确认结束的 HeadlessEdge 临时目录；回收站、用户资料、模型、SDK 和项目环境保留。scripts/windows-wsl-maintenance.py 默认预览，Windows 执行入口及当前清单位于 D:\Wayfarer-Acceptance\storage-audit-20261118。WSL 仍运行，正式离线维护留到当前任务和 Agent 会话结束后，固定交换文件目标为 F:\WSL\swap.vhdx。

维护命令：npm run typecheck、npm test、npm run test:portable、npm run package。实机图形捕获差异与覆盖边界见 docs/ACCEPTANCE.md。交付后同步两个主仓库并清理开发工作树。
