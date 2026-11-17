# Workspace Map

Windows、WSL、SSH 共用的目录画布与 Agent 文件管理器。文件系统是真实数据源；画布、VS Code 编辑器与 MCP 使用同一个操作核心。

安装 VSIX 后执行 **Workspace Map: 打开目录地图**。空白处拖动平移，滚轮缩放，箭头展开目录，双击进入子树。文件右侧的手柄用于真实搬移；单击选择后可新建、编辑、重命名、多选复制／移动、删除、统计大小和管理软件。隐藏文件默认显示。

## 连接与 Agent

Windows 磁盘和 WSL 发行版自动发现。通过 **Workspace Map: 添加 SSH 连接** 选择 SSH 配置所在环境，导入具体 Host 或输入 `user@host`。使用该环境原有的 OpenSSH 配置、密钥和已知主机记录。首版 SSH 文件端点支持 Linux／POSIX，助手兼容 Python 3.6+。

**接入 Codex** 使用已发现的 Codex CLI 增改 `workspace-map` MCP 项；**接入 dsh** 列出实际环境中的 profile，仅修改选中 profile 的本插件项。当前 dsh bundle profile 写入 `cordis.patch.yml` 的插件插入项；旧 profile 保留 `cordis.yml` 接法。现有插件、注释和授权策略继续保留。**获取 MCP 配置** 提供 WSL 与 Windows 调用形式。

每个 VS Code 窗口有独立会话。Agent 通过 `map_sessions` 查看、`map_bind` 切换；快捷接入生成的配置绑定当前窗口。重开后可通过这两个工具重新绑定。跟随默认关闭，开启后显示 Agent 当前目录／文件位置；手动操作退出跟随。

MCP 提供端点、分页目录、文件元数据／内容、导航、搜索、文件操作、包操作、资源统计和任务状态。`map_diagnostics` 直接返回缓存、监听、未完成分页和任务计数；`map_resources` 返回指定端点的进程资源与连接累计通信计数。文件读取返回 Base64，支持字节偏移与长度。后台操作立即返回任务 ID；`map_job` 查询结果，`map_jobControl` 暂停／继续／取消，日志通知推送任务进度。

## 文件与软件操作

同端移动优先原生重命名；跨文件系统／跨端使用任务私有暂存文件，校验内容与源版本后提交，再删除源。暂停任务保存进度；重开窗口后显式继续。同名规则包括跳过、改名，以及合并目录并覆盖同名文件。目录合并保留目标中其他条目。目录与普通文件的类型冲突单独报告。

Windows 删除进入回收站；WSL／Linux SSH 删除为永久删除。软链接按链接复制，进入链接目录需要明确导航。Windows／WSL 盘符映射用于识别重复路径。程序只搬移文件系统内容；项目配置、环境变量和 Git worktree 引用由用户或 Agent 另行处理。

包管理面板绑定选中目录和端点，显示实际 argv、来源、退出码及日志；可指定解释器或管理器的绝对路径。支持 uv／pip、npm／pnpm／bun、JDK／Gradle／Maven 缓存、Android sdkmanager、Flutter、rustup／cargo、winget。能力表由适配器声明，管理器安装状态在用户查询时发现。运行修改命令使用当前端点账号。

## 性能与记录

- 每页默认 200 条；画布、编辑器和 Agent 独立持有分页游标。
- D3 布局在 Web Worker；普通视角按可见区域渲染，远景用 Canvas 表示目录结构。
- 目录缓存上限 128 个分支、16,000 条首屏记录；本机文件事件和 Linux inotify 监测已展开分支，远端读取事件队列。
- 复制任务复用 4 × 1 MiB 数据缓冲；任务检查点增量写入，避免按文件数反复序列化整份历史。
- 默认两个传输任务并行；冲突路径串行。包环境和项目分别参与互斥，目录读取走独立调用。
- **查看性能日志** 打开 OutputChannel，包含目录读取、布局、任务排队／吞吐、包命令、Extension Host CPU／RSS、Webview heap／长任务、端点助手 CPU／RSS。

运行状态位于 VS Code globalStorage。任务 `*.json` 保存状态，`*.input.json` 保存提交参数，`*.checkpoint.jsonl` 保存增量检查点，`*.log` 保存收到的命令输出。任务详情显示日志尾部。WSL 的私有 socket 与 MCP 客户端入口位于 `~/.local/share/workspace-map/`；助手随连接／窗口关闭退出。大文件传输使用按任务租用的数据助手，目录与编辑操作保留独立控制通道；最后一个传输结束、暂停或取消后释放数据助手。

## 构建与验收

开发环境：Node.js 22+、Python 3.6+；VS Code 1.95+。统一构建入口可执行：

```sh
npm ci
npm run typecheck
npm test
npm run package
```

产物：`artifacts/workspace-map.vsix`，附带 `dist/build-info.json` 记录提交、工作树状态与构建环境。性能命令：`npm run bench`；多小文件场景：`npx tsx scripts/benchmark-small.ts`。

`ARCHITECTURE.md` 说明模块和恢复流程，`PERFORMANCE.md` 保留实测结果，`STATE.md` 记录交付状态。实际机器验收脚本位于 `scripts/`，使用独立临时文件／软件环境。

首版边界：编辑器读取上限 64 MiB，较大文件可传输后使用本机工具打开；搜索最多保留 10,000 个匹配；目录游标闲置 120 秒后刷新。暂停／取消在当前执行段结束时生效；已经提交的文件保留，未完成暂存文件用于恢复。包管理器支持取消，完成状态以实际退出信息为准。升级、SDK 安装等命令配方已接入；发布验收对修改操作使用隔离的 pip／npm 测试包，其他生态按本机安装环境使用。

Marketplace 发布单独处理。
