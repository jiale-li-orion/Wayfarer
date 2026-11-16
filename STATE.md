# Workspace Map · 0.1.0

实现与验收已完成。开发在训练机独立工作树；主仓库位于 /data/users/lijiale/projects/agent-system-learning/workspace-map。本机交付镜像位于 /home/orion/agent-system-learning/workspace-map；后续源码修改继续在训练机新建工作树。

## 当前交付

Windows UI Extension Host、WSL／SSH 文件访问、React Flow／D3 Worker／Canvas 远景、真实文件操作、可恢复传输、软件管理适配器、MCP 和 Codex／dsh 配置入口均已实现。标准入口为 npm run typecheck、npm test、npm run package。VSIX 与运行安装回执保存在 artifacts，构建记录随 VSIX 放在 dist/build-info.json。

## 验证事实

- 18 项定向测试通过；覆盖分页隔离／重复请求、多选包含关系、冲突合并、链接、权限、源变化、断点恢复、完成结果按需加载、Agent 跟随／历史、dsh 配置保留、跨系统路径。
- Windows、Ubuntu WSL、训练机、推理机和额外 SSH 连接实例实际读取成功。推理机 Python 3.6.8 助手已执行。
- Windows → train → infer → WSL 的临时文件复制／移动完成；隔离 pip／npm 环境安装、清单、卸载完成。
- 64 MiB 移动在传到 4 MiB 后主动断连，源文件保留、其他端点继续浏览；重连续传完成，SHA-256 一致。
- Windows 大小写重命名成功；Windows／WSL 同文件搬移被识别；junction 在 Windows 保留类型，跨到不支持的文件系统时保留源并报告。
- 安装版 UI 实际通过手柄拖动、操作预览、搬移、双击进入目录、返回；VS Code FileSystemProvider 打开并保存了 WSL 文件。
- 关闭并重开独立 VS Code 进程后，地图标签恢复，根目录和镜头坐标一致，跟随默认关闭。
- 实际 dsh MCP SDK 2.2.0 完成握手、工具发现、端点与视图读取；Codex CLI 接受生成的 stdio 配置。模型自主操作未作为验收手段。
- 千节点、64 MiB 文件和 600 个小文件的 CPU／内存原始记录见 docs/performance-data；解释与重测入口见 PERFORMANCE.md。

实际包修改测试覆盖 pip／npm；其余生态的命令适配器已接入。Marketplace 发布与 GitHub 远端发布分别处理；当前采用独立 Git 仓库和 VSIX 交付。

## 继续开发

先读 ARCHITECTURE.md，再沿源码处理对应模块。共享 Core 是状态与操作入口；UI、编辑器、Agent 的分页游标各自持有。完成结果与输入按需读盘，活动传输以增量检查点恢复。保持这些边界，新增适配器复用现有任务与日志通道。
