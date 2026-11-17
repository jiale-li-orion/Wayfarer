# Workspace Map · 0.3.1

训练机主仓库：`/data/users/lijiale/projects/agent-system-learning/workspace-map`；本机镜像与 VSIX：`/home/orion/agent-system-learning/workspace-map`。开发在训练机独立 worktree，本机安装验收。仓库为 `jiale-li-orion/Wayfarer`，插件显示名称 Workspace Map。

## 环境精简与生态评审（2026-11-18）

日常 Windows／WSL 处置已完成：12 种扩展的 14 份安装移除；停用内置 Copilot 业务入口，保留编辑、语言与专业生态。约 60 秒对照中 WSL 宿主 PSS 414 → 263MiB，CPU 原值单列。图标项目识别路径问题通过支持的设置处理，地图 MCP 改用稳定 mapId。四端目录、TS 查询和缓冲区修改、停用 Copilot 后的现有工具调用通过；dsh CLI 启动通过。图片插入通过，剪贴板恢复失败已记录并移除一次性脚本。

[资源与处置](docs/ENVIRONMENT_AUDIT.md)与[共享环境评审](docs/SHARED_ENVIRONMENT_REVIEW.md)为本轮交付。已确认 Codex 两端包中有默认关闭的实验 LSP MCP（诊断／引用／工作区符号），下一轮先评审复用，再补缺口。公共 API 与 0.3.1 产品实现保持现状。

## 当前入口更新

0.3.1 补齐原生活动栏／侧边栏和快捷键，复用 0.3.0 地图、任务与 Agent 核心。原生活动栏、机器／书签／操作导航与快捷键已完成独立窗口验收；类型检查、48 项检查与打包通过。Windows 推理机桥接本轮出现退出码 4294967295，保留为验收缺口。详见 docs/ACCEPTANCE.md。

## 当前交付

PR #3 交付 Agent resume、自动续传与资源生命周期，已完成连接、传输及资源验收。0.2.0 的详情、工具清单、占用统计、历史分页及 CI／Release 沿原入口运行。

- Agent 用持久 mapId 选择地图，运行 id 随重载更新。一个客户端使用一个恢复流程；重连先取视图与任务快照，再接收事件。解绑释放旧 socket、等待器、订阅及客户端游标，后台任务归地图。
- operationId 与参数指纹、任务及归档位置一起保存；确认丢失时先查收据。同 ID 同参数返回原任务，包命令重新执行由用户提交新操作。
- 窗口、进程或网络中断的传输自动接续；主动暂停、主动断开、取消和缺少原因的旧记录分别保留原意。快速点击继续会等上一执行段结束再调度，路径锁与分片校验沿既有机制。
- 取消只清理登记的私有暂存。清理失败项随任务归档，任务面板与 map_jobCleanup 提供明确重试入口。已提交目标和源处理事实分别保留。
- 地图退出停止接单、等待 runner finally、日志和检查点落盘，共用 1.5 秒宽限；Endpoint、relay、后台包进程、游标及退休连接按归属释放。诊断提供客户端、pending、订阅、runner、游标、租约、缓冲和退出阶段。

## 验证入口

48 项定向检查包含提交确认丢失、窗口恢复、helper 实际断开、主动断开、旧任务迁移、旧版 MCP 分页、取消清理、迟到游标、悬挂文件调用退出与 50 轮绑定／10 轮实例替换。Windows 安装验收完成 10 次真实重载、50 次绑定、Windows／WSL／训练机／推理机目录读取，以及实际 Codex／dsh 查询。资源结果见 PERFORMANCE.md 与 docs/ACCEPTANCE.md：50 轮绑定的 MCP RSS 约 18.14MiB；600 秒待机采样完成；64MiB 传输中重载后内容核对一致。

- `npm run typecheck`、`npm test`、Windows `npm run test:portable`。
- `node --expose-gc --import tsx scripts/profile-resume.mjs <output.json>`：隔离 fixture 的 50 轮切换及关闭计数／内存。
- 产品关系见 ARCHITECTURE.md；升级、回退和配置见 docs/RELEASE.md；性能原始记录见 docs/performance-data。

发布沿 GitHub PR、main 检查与 v0.3.0 标签生成 VSIX、SHA-256 和提交元数据。交付后清理开发工作树。协同整理与 Marketplace 按后续需求推进。
