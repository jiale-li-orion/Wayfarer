# Workspace Map

Windows、WSL、SSH 共用的目录画布与 Agent 文件管理器。文件系统是真实数据源；画布、VS Code 编辑器与 MCP 使用同一个操作核心。

安装 VSIX 后执行 **Workspace Map: 打开目录地图**。空白处拖动平移，滚轮缩放，箭头展开目录，双击进入子树。文件右侧的手柄用于真实搬移；单击选择后可新建、编辑、重命名、多选复制／移动、删除、统计大小和管理软件。隐藏文件默认显示。

## 连接与 Agent

Windows 磁盘和 WSL 发行版自动发现。通过 **Workspace Map: 添加 SSH 连接** 选择 SSH 配置所在环境，导入具体 Host 或输入 `user@host`。使用该环境原有的 OpenSSH 配置、密钥和已知主机记录。首版 SSH 文件端点支持 Linux／POSIX，助手兼容 Python 3.6+。

**接入 Codex** 使用已发现的 Codex CLI 增改 `workspace-map` MCP 项；**接入 dsh** 列出实际环境中的 profile，仅修改选中 profile 的本插件项。当前 dsh bundle profile 写入 `cordis.patch.yml` 的插件插入项；旧 profile 保留 `cordis.yml` 接法。现有插件、注释和授权策略继续保留。**获取 MCP 配置** 提供 WSL 与 Windows 调用形式。

每个 VS Code 窗口有独立地图。`mapId` 是持久身份，`id` 表示本次运行；Agent 通过 `map_sessions` 查看、`map_bind` 切换。快捷接入生成 `--map` 稳定绑定，重载后自动接回同一地图；`map_connection` 查询连接状态与交接快照。升级后重新执行接入命令可更新原插件项，旧 `--session` 接法和分页继续兼容。跟随默认关闭，开启后显示 Agent 当前目录／文件位置；手动操作退出跟随。

MCP 提供端点、分页目录、文件元数据／内容、导航、搜索、文件操作、包操作、资源统计和任务状态。`map_diagnostics` 直接返回缓存、监听、未完成分页和任务计数；`map_resources` 返回指定端点的进程资源与连接累计通信计数。文件读取返回 Base64，支持字节偏移与长度。后台提交持久化后返回任务 ID 和 operationId；相同 token 查询原任务，确认中断先用 `map_operation` 查收据。`map_job` 查询结果，`map_jobControl` 暂停／继续／取消，日志通知推送任务进度。

## 文件与软件操作

同端移动优先原生重命名；跨文件系统／跨端使用任务私有暂存文件，校验内容与源版本后提交，再删除源。窗口、进程和网络中断的传输自动接续；主动暂停和主动断开保持暂停，用户点击继续。取消清理登记的私有暂存，失败项随任务保留，可从任务面板或 `map_jobCleanup` 明确重试。同名规则包括跳过、改名，以及合并目录并覆盖同名文件。目录合并保留目标中其他条目。目录与普通文件的类型冲突单独报告。

Windows 删除进入回收站；WSL／Linux SSH 删除为永久删除。软链接按链接复制，进入链接目录需要明确导航。Windows／WSL 盘符映射用于识别重复路径。程序只搬移文件系统内容；项目配置、环境变量和 Git worktree 引用由用户或 Agent 另行处理。

包管理面板绑定选中目录和端点，显示实际 argv、来源、退出码及日志；可指定解释器或管理器的绝对路径。支持 uv／pip、npm／pnpm／bun、JDK／Gradle／Maven 缓存、Android sdkmanager、Flutter、rustup／cargo、winget。能力表由适配器声明，管理器安装状态在用户查询时发现。运行修改命令使用当前端点账号。

## 性能与记录

- 每页默认 200 条；画布、编辑器和 Agent 独立持有分页游标。
- D3 布局在 Web Worker；普通视角按可见区域渲染，远景用 Canvas 表示目录结构。
- 目录缓存上限 128 个分支、16,000 条首屏记录；本机文件事件和 Linux inotify 监测已展开分支，远端读取事件队列。
- 复制任务复用 4 × 1 MiB 数据缓冲；任务检查点增量写入，避免按文件数反复序列化整份历史。
- 默认两个传输任务并行；冲突路径串行。包环境和项目分别参与互斥，目录读取走独立调用。
- **查看性能日志** 打开 OutputChannel，包含目录读取、布局、任务排队／吞吐、包命令、Extension Host CPU／RSS、Webview heap／长任务、端点助手 CPU／RSS。

运行状态位于 VS Code globalStorage。任务 `*.json` 保存状态，`*.input.json` 保存提交参数，`*.checkpoint.jsonl` 保存增量检查点，`*.log` 保存收到的命令输出；`operations/` 保存 operationId 对应归档位置，`history/` 保存完成与取消记录。任务详情显示日志尾部。WSL 的私有 socket 与 MCP 客户端入口位于 `~/.local/share/workspace-map/`；助手随连接／窗口关闭退出。大文件传输使用按任务租用的数据助手，目录与编辑操作保留独立控制通道；最后一个传输结束、暂停或取消后释放数据助手。

## 构建与验收

开发环境：Node.js 22+、Python 3.6+；VS Code 1.95+。统一构建入口可执行：

```sh
npm ci
npm run typecheck
npm test
npm run package
```

产物：`artifacts/workspace-map.vsix`，附带 `dist/build-info.json` 记录提交、工作树状态与构建环境。性能命令：`npm run bench`；恢复与资源循环：`node --expose-gc --import tsx scripts/profile-resume.mjs <output.json>`；多小文件场景：`npx tsx scripts/benchmark-small.ts`。

`ARCHITECTURE.md` 说明模块和恢复流程，`PERFORMANCE.md` 保留实测结果，`STATE.md` 记录交付状态。实际机器验收脚本位于 `scripts/`，使用独立临时文件／软件环境。

首版边界：编辑器读取上限 64 MiB，较大文件可传输后使用本机工具打开；搜索最多保留 10,000 个匹配；目录游标闲置 120 秒后刷新。暂停／取消在当前执行段结束时生效；已经提交的文件保留，暂停时的暂存用于恢复，取消时按登记归属清理。包管理器支持取消，完成状态以实际退出信息为准。升级、SDK 安装等命令配方已接入；发布验收对修改操作使用隔离的 pip／npm 测试包，其他生态按本机安装环境使用。

Marketplace 发布单独处理。


### 详情与日常管理

选中节点，点击工具栏的 **详情与环境**。路径按钮定位画布；文件在 VS Code 编辑器打开。目录面板显示当前层项目标记，可登记项目，查询工具路径／版本／环境；包安装、升级及缓存清理继续从 **包管理与命令预览** 进入，确认实际端点、解释器、目录和命令后执行。

**占用** 中点击当前目录或缓存旁的 **统计**；后台显示文件数、已统计字节与取消入口。统计结果带查询时间，部分无权限路径计入结果提示。已登记项目、查询快照、书签及任务记录随地图会话保存。后台任务面板分页浏览完成和取消的任务，运行中及可恢复任务单列；详情与日志按需打开。

MCP 客户端可调用 `map_inspect` / `map_inventory` / `map_jobsPage` 使用同一实现。库存查询返回任务 ID，用 `map_job` 查看输出，用 `map_jobControl` 取消。`map_packageDiscover` 支持 `refresh:true` 手动更新管理器路径。


### 发布与维护

源码仓库为 [Wayfarer](https://github.com/jiale-li-orion/Wayfarer)，插件继续显示 Workspace Map。构建、安装、升级、回退与 MCP 配置说明见 [docs/RELEASE.md](docs/RELEASE.md)，实际机器覆盖见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。标签工作流交付 VSIX、SHA-256、提交身份和版本说明；PR 产物供审阅验收。

## 侧边栏与快捷键（0.3.1）

点击活动栏的地图图标，展开 **机器／书签／常用操作**。点击机器或书签在编辑区打开对应地图。标题栏提供打开地图、添加 SSH 和后台任务；常用操作还提供搜索、Codex／dsh 接入、MCP 配置和性能日志。侧边栏可通过 VS Code 的视图菜单移到右侧。

| 操作 | Windows／Linux | 生效位置 |
|---|---|---|
| 打开／聚焦地图 | Ctrl+Alt+M | 全局 |
| 聚焦侧边栏 | Ctrl+Alt+Shift+M | 全局 |
| 返回／前进 | Alt+←／Alt+→ | 地图 |
| 上一级 | Alt+↑ | 地图 |
| 搜索当前子树 | Ctrl+F | 地图 |
| 后台任务 | Ctrl+Shift+J | 地图 |
| 定位已加载节点 | Ctrl+0 | 地图 |

macOS 将 Ctrl 换成 Cmd。按键可在 VS Code「键盘快捷方式」中搜索 Workspace Map 后修改。侧边栏沿用 VS Code 的方向键、Enter 和展开／收起操作。

### 机器资源

侧边栏「常用操作 → 机器资源」查看 Windows、WSL 与 SSH 主机；四端摘要、进程分页、GPU 和磁盘／网络逐级展开。页面隐藏停止自动采样，明确开始的记录保留后台生命周期。MCP 使用只读 `map_systemResources`；具体口径、资源归属和导出见 [说明](docs/SYSTEM_RESOURCES.md)。

### 与现有 VS Code 生态协作

[日常扩展与资源记录](docs/ENVIRONMENT_AUDIT.md)记录实际精简与对照条件；[Codex／dsh 共享环境评审](docs/SHARED_ENVIRONMENT_REVIEW.md)梳理现有语言服务、扩展工具、Codex 实验 LSP MCP 与 Wayfarer 的接入边界。该评审记录现有能力与后续接入边界；产品现状见 STATE.md。

### 常用工作区与项目环境（0.5.0）

侧边栏收藏常用工作区，点击使用 VS Code 原生打开；右键可新窗口打开、加入当前工作区、定位地图及查看环境。目录详情与常用工作区共用“项目环境”视图，多根项目分别查看。Python 默认 uv，项目清单／锁文件与环境同步分开管理；版本、依赖和占用按需查询。具体行为见 [项目环境说明](docs/PROJECT_ENVIRONMENTS.md)。

存储分析支持卷容量、目录排名、实际占盘与硬链接共享、WSL 承载关系、快照分页和导出。侧边栏“存储占用”进入，目录详情的统计按钮使用同一页面。接口与口径见 [存储分析](docs/STORAGE.md)。

Windows离线交换文件维护与退出码见 [维护说明](docs/WSL_MAINTENANCE.md)，当前窗口内存分组及页面对照见 [性能记录](PERFORMANCE.md)。

## 收藏、查找与 SSH

侧边栏“收藏”统一保存项目目录和 `.code-workspace`；项目原生打开，右键“地图定位”回到同一目录。未绑定 Windows Remote SSH 的远端收藏先在地图定位，原生打开沿原有显式绑定方式。旧地图书签在打开该地图时迁移，现有名称和收藏保留。

“按名称找文件”只在当前目录范围查找名称，显示实际机器和路径；源码内容搜索继续使用编辑器或 rg。“传输与后台任务”查看复制、移动、扫描、包命令的进度和恢复。“诊断日志”放在折叠的“诊断与接入”，机器 CPU／内存走“机器资源”。

“添加 SSH 连接”：输入 `user@host`（可加 `:port`）→ 在 SSH 终端确认主机并输入密码 → 自动安装专用公钥、验证免密及 Python → 命名并保存连接。机器右键可重命名；已有 train/infer 等 OpenSSH 配置从“诊断与接入 → 导入已有 SSH 配置”导入。命名 SSH 机器在同一 VS Code 配置档案的窗口之间共享。详见 [SSH 连接](docs/SSH.md)。

### 多机巡检与性能对照（0.8.0）

机器资源页可对照多台机器、共享挂载和私网链路。传输性能详情和运行报告用横条及时间线展示阶段耗时。项目脚本写入版本化记录，Wayfarer 按需读取并定位原始日志。[使用与接口说明](docs/MULTI_MACHINE_PERFORMANCE.md)
