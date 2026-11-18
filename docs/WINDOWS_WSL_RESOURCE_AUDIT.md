# Windows／WSL 双端资源复核 · 2026-11-18

测量日常 Windows VS Code 1.146.0 的主进程 13228 及其子进程，并同步采样 WSL 编辑器、Agent 和地图助手。第一段约 90 秒，第二段约 60 秒；采样时 Codex 当前回合继续执行，期间浏览器曾在前台。这是实际使用记录，严格待机和相同工作负载的因果对照另行测量。CPU 按一个逻辑核计算，本机共有 12 个逻辑核。

| 对象 | 第一段 | 第二段 | 内存口径 |
|---|---:|---:|---|
| Windows VS Code 整棵进程树 | 2220 MiB | 2110 MiB | 每次采样私有提交量之和的中位值 |
| Windows 同组工作集 | 1752 MiB | 1651 MiB | 含共享页，单独记录 |
| WSL 编辑器与 Agent 相关进程 | 1061 MiB | 1058 MiB | 每次采样 PSS 之和的中位值 |
| Windows 同组 CPU | 33.47% | 23.92% | 存活进程 CPU 时间增量之和／墙钟时间 |
| WSL 同组 CPU | 8.12% | 8.29% | 同上 |

私有提交量表示进程承担的内存提交，物理驻留由工作集观察。Linux PSS 按共享份额分摊。Windows 的 vmmemWSL 包含整台 WSL 虚拟机，单列观察；跨端进程数字与虚拟机工作集分别呈现。

第一段 Windows 最大渲染进程 20888 的私有提交量中位值为 683 MiB、工作集 534 MiB、CPU 13.35%；主编辑器渲染进程 2452 分别为 397 MiB、226 MiB、3.66%。GPU 进程为 270 MiB 私有提交量、14.36% CPU；本地扩展宿主为 139 MiB、0.069% CPU。当前工作区保存的 Webview 编辑器包括 Workspace Map、GitHub PR 概览和 Markdown 预览，另外运行 Codex 侧栏。逐页 CPU 归属需要记录对应渲染目标；这里按已核对的 PID 和进程类型归档。

WSL 扩展宿主约 402 MiB PSS，Codex app-server 约 355 MiB，文件监听约 48 MiB，JSON 语言服务约 28 MiB。地图诊断为隐藏、零目录监听、零轮询、零传输缓冲、零运行任务，缓存 34 个分支／901 条目录项。现有源码设置 retainContextWhenHidden=false，隐藏后通过持久视图重新构建界面，后台 Core 继续服务 MCP 和文件编辑器。

另查到两个本地构建进程：KotlinCompileDaemon（PID 374345，Gradle 子进程）约 1611 MiB PSS／457 MiB swap；GradleDaemon（PID 280510）约 931 MiB PSS／176 MiB swap。Gradle 日志最后一次构建于 00:23:35 完成并标记 idle。两者属于构建运行时，当前保留；后续按构建任务管理空闲退出。开发和构建继续以训练机既有流程为主。本机还运行容器内业务进程，资源归入各自业务。

本轮仅追加两项 Windows 用户配置：workbench.reduceMotion=on、editor.cursorBlinking=solid，关闭界面过渡动画和光标闪烁。配置键与取值对照当前安装源码核验，其他设置逐项保持。第二段 Windows CPU 和提交量下降，期间存在 Agent 输出、垃圾回收和页面活动变化，收益继续通过相同动作的重复采样检验。现有窗口、文档、账号、语言服务、Git、GPU 加速、端口转发和 Agent 配置保持。

轻量化按归属推进：Windows 优先测实际 Webview 的渲染、DOM／JS heap 和隐藏后的释放；WSL 按选定项目运行语言服务；构建进程按任务回收。Wayfarer 的能力发现先读清单，索引、统计和执行按调用启动。工具安装保持可用，进程启动绑定项目和任务；CPU／内存清单同时覆盖 Windows 与 WSL，并标明具体提供者、PID、项目和生命周期。GPU 加速继续使用现有配置，资源复核观察 CPU、GPU 与交互帧耗时。

[原始统计摘要](performance-data/environment-audit-20261118/dual-end.json)。本机完整采样位于 artifacts/environment-audit-20261118/dual-end。采样器读取进程参数后只保留角色与资源数字；本轮临时截图和脚本交付后清除。复核方法参考 [VS Code Performance Issues](https://github.com/microsoft/vscode/wiki/Performance-Issues)，渲染进程和扩展宿主分别录制性能轨迹。
