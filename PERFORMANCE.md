# CPU、内存与传输验收 · 2026-11-17

本轮交付 0.1.1。Windows VS Code 1.146、Ubuntu WSL、训练机和推理机均参与验收；远端助手兼容推理机 Python 3.6。源码版本与测量范围见 [provenance.json](docs/performance-data/20261117/provenance.json)，原始数据集中在 [20261117](docs/performance-data/20261117)。

## 同场景对比

| 场景 | 修改前 | 修改后 | 对应改动 |
|---|---:|---:|---|
| 收起目录后，迟到回复留下的游标 | 1 | 0 | 回复交接时核对请求归属 |
| 同分支 600 次失效发出的刷新通知 | 600 | 1 | 150ms 固定窗口按分支合并 |
| 并行大文件期间，本机目录查询 p95（三轮中位值） | 50.8ms | 32.1ms | 文件属性每批并发 16 项 |
| SSH 上传期间，目录查询 p95（三轮中位值） | 956ms | 156ms | 文件数据与目录控制分通道 |
| SSH 下载期间，目录查询 p95（三轮中位值） | 981ms | 46ms | 同上 |
| 200 个小文件到 SSH：墙钟时间 | 36.83s | 12.10s | 最多四个小文件并行 |
| 同一批小文件：客户端 CPU 时间 | 2.89s | 1.40s | 重叠远端往返；任务共用四块 1MiB 缓冲 |

SSH 对比每轮传输 64MiB，三轮前后交替运行，往返 SHA-256 一致。网络吞吐存在波动：上传墙钟范围为修改前 3.20–9.05s、修改后 4.22–6.12s；下载为修改前 6.89–12.92s、修改后 5.46–10.87s。目录延迟在三轮中均改善。小文件对比使用 200 × 7 字节文件，统计完整文件创建、校验、提交和任务记录。

独立数据通道按任务租用，同一端点的并行传输共享一条数据通道。一次附加内存采样中，控制助手与数据助手合计峰值 RSS 53.6–57.8MiB；传输结束后数据助手退出，控制助手维持 22.9MiB。RSS 包含共享页。单通道样本的传输后 RSS 为 25.8–33.8MiB。普通浏览与端内直接移动沿用控制连接。

## 长时资源与安装版交互

四端连接、四端展开、切至空白页签各完成连续 600 秒采样，间隔 15 秒。表中 CPU 使用各段第 120 秒以后的样本，按单核百分比计算，包含采样开销。

| 状态 | Extension Host CPU | WSL 助手 CPU | 训练机助手 CPU | 推理机助手 CPU | 目录监听 |
|---|---:|---:|---:|---:|---:|
| 四端连接、目录收起 | 0.044% | 0.0061% | 0.0024% | 0.0039% | 0 |
| 四端目录展开 | 0.083% | 0.0153% | 0.0037% | 0.0081% | 4 |
| 空白页签 | 0.046% | 0.0124% | 0.0028% | 0.0037% | 0 |

隐藏段 40 个样本的画布状态均为隐藏，监听、游标、待处理 UI 读取和轮询定时器均为零。助手 RSS 约为 WSL 18–21MiB、训练机 23–25MiB、推理机 16MiB。关闭窗口后按 PID 核对三个助手均已退出。地图页签关闭后，端点连接继续服务编辑器／MCP；断开端点或关闭窗口释放这些连接。

安装版完成 160 次目录切换：后几轮缓存稳定在 128 个分支，强制 GC 后 Webview JS heap 为 4.45–4.98MiB。该数值只描述 JS heap；Windows 工作集、私有提交量、绘图缓冲和 Extension Host 分别记录。两个 64MiB 文件同时向训练机、推理机上传成功并核对摘要，期间 120 次缩放的帧间隔 p95 为 17.0ms，最大 33.4ms。新安装版的 200 文件 SSH 传输耗时 11.23s。取消保留源文件，任务结束后运行任务、路径锁及进度定时器归零。

空白 VS Code 对照额外采样 180 秒，取第 60 秒后的进程组中位值：RSS 约 1257MiB、PrivateBytes 约 819MiB；完成工作负载并隐藏地图的窗口分别约 1310MiB、832MiB，差值约 53MiB 与 13MiB。此处比较整个独立窗口的 Windows 进程组，包含内置扩展与编辑状态；Linux 助手另计，PrivateBytes 表示私有提交量。

Extension Host 是共享进程，包含 VS Code 内置扩展；CPU/RSS 按进程标明归属。Windows 工作集会被系统回收，配合 PrivateBytes、JS heap 和插件自身计数解读。CDP 测量保持 Webview 可见以支持帧测量；隐藏阶段使用真实的编辑器页签切换。首轮隐藏段被手动切回地图，最终记录采用另一次完整连续隐藏采样。日常工作窗口仅记录进程资源，测试文件操作位于隔离窗口和临时目录。

## 验收覆盖

- 28 项定向测试通过：分页隔离、迟到回复、可见性与编辑器监听、文件冲突、链接、源变化、暂停恢复、传输通道租约、缓冲复用、dsh 配置保留等。
- 安装版验证 Windows／WSL／训练机／推理机目录读取、160 次导航、Agent 手动接管、并行传输、取消、隐藏／关闭地图和资源回收。
- 实际 dsh headless 会话完成读取目录、定位地图、复制文件、查询任务、读取结果。Codex 的只读测试会话完成读取、定位，写入请求按该会话策略被拒绝；既有授权配置保持原样。
- 独立环境验证 uv、pnpm、bun 安装／查询／卸载；npm 安装钩子运行中取消，进程被回收。Java 版本查询、Gradle／Maven 指定测试缓存盘点与清理通过。当前 WSL PATH 中未发现 cargo／rustup，本轮记录为未运行。
- 包命令按 100ms 间隔采样直接子进程；pnpm 安装采样峰值约 181MiB，npm 取消样本约 87MiB。这些用量属于包管理器进程。短命令可能在采样间隔内结束，原始零值表示未捕获运行态峰值。

## 复测入口与日志

```sh
npm run typecheck
npm test
node --expose-gc --import tsx scripts/benchmark-lifecycle.ts artifacts/core.json
```

Windows 安装版脚本在 WSL 执行，显式设置 `WM_SESSION`、`WM_CDP_PORT`、`WM_PROFILE_NAME` 和 `WM_SSH_CONFIG`，绑定独立 `acceptance…` 验收窗口：

- `scripts/profile-lifecycle.mjs artifacts/idle.jsonl`：默认三段各 600 秒；`WM_PHASES=hidden` 可单独补测隐藏。
- `scripts/verify-lifecycle.mjs artifacts/interaction.json`：导航、并行传输、取消、页签关闭与回收。
- `scripts/verify-packages.mjs artifacts/packages.json`：临时包与环境验证。
- `scripts/profile-control.mjs artifacts/control.jsonl`：空白 VS Code 对照，`WM_CONTROL_SECONDS` 指定采样时长。

窗口命令先定位并激活指定验收窗口，确认命令输入框后再输入；关闭地图使用该页签的 Close 按钮，兼容本机 Ctrl+F4 绑定。真实数据移动使用显式临时 fixture。

产品日志位于 Workspace Map OutputChannel。`host.resources` 标记共享宿主，`ui.resources` 给出 heap、节点与缓存数量；`map_diagnostics` 查询监听、缓存、游标和任务计数。`map_resources.transport` 为控制通道累计通信计数，`transfer` 为活动数据助手资源，`lastTransferTransport` 为刚结束数据通道的计数。RPC 累计时间包含并行等待，任务墙钟时间见 `job.start`／`job.end`。传输错误回复计数也包含目标存在性探测，任务最终状态由任务记录承担。

## 0.2.0 日常管理复测 · 2026-11-17

同一训练机、Node 22.23.2、3,000 条旧版任务 journal；`scripts/profile-management.ts` 分别加载 f337610 与日常管理分支。下面为单轮 cold／warm 原始记录，warm 指首次归档迁移后的再次启动。

| 项目 | 0.1.1 | 0.2.0 |
|---|---:|---:|
| 首次加载＋旧记录迁移 | 151.5ms | 273.8ms |
| warm 启动 | 148.0ms | 3.4ms |
| warm 启动 CPU 时间 | 224.4ms | 16.9ms |
| 历史任务常驻记录 | 3,000 | 0 |
| 首次加载后的 GC 堆增量 | 2.64MiB | 0.17MiB |
| 历史摘要首屏 | 378,781B／3,000 条 | 3,894B／30 条 |
| warm 历史页读取 | 1.7ms（全部摘要） | 7.0ms（磁盘页） |
| 刷新目录 p95（30 次） | 0.15ms | 0.20ms |

首次迁移增加文件移动开销；后续启动只清点归档文件名。历史翻页使用磁盘读取换取有界常驻内存。20 个同时详情请求合并为一次检查，随后 200 次缓存查询新增端点调用为 0。查询快照限制 64 项／8MiB。

Windows VS Code 1.146.0 的两个独立验收窗口连接 Windows／WSL／训练机／推理机。两窗口均固定在 WSL 家目录、一个监听分支，连续静置 60 秒，采样前后核对根目录和监听数。

| 资源 | 0.1.1 | 0.2.0 |
|---|---:|---:|
| Webview CPU（单核时间占比） | 0.035% | 0.037% |
| 独立验收宿主 CPU | 0.052% | 0.025% |
| Webview JS heap | 4.67MiB | 5.39MiB |
| 宿主 Working Set 原始值 | 141.1MiB | 63.0MiB |

宿主包含内置扩展，Working Set 受 Windows 页面回收影响；该列保留观测值。WSL／SSH 助手及包子进程的原始资源计数随记录保存。0.1.1 的三段 600 秒长时间基线继续见上文，本轮新增功能使用 60 秒对照和面板回收验收。

- 详情面板开关 30 次并 GC：JS heap 3.65→3.78MiB，监听数 254→254；关闭面板后监听数 234。查询 pending 为 0，后台包进程为 0。
- 16MiB Windows→训练机复制并回读核对共 4.80 秒，SHA-256 一致；复制期间并行刷新目录 p95 为 9.35ms。此耗时包含回读校验，完整复制调度耗时由任务 created／updated 与 job.end 日志记录。
- 四端工具版本任务分别完成；Android SDK 清单、Flutter 版本、winget 软件清单通过共享包适配器查询。修改类包操作沿用 0.1.1 的隔离环境覆盖范围。
- 实际 Codex 与 dsh 会话完成 endpoints→inspect→jobsPage→navigate；固定验收会话，跟随关闭，用户现有授权配置保留。

数据入口：[baseline.json](docs/performance-data/20261117-management/baseline.json)、[candidate.json](docs/performance-data/20261117-management/candidate.json)、[windows-management.json](docs/performance-data/20261117-management/windows-management.json)。原始窗口日志保存在本机交付 artifacts，公开记录仅保留工具身份与资源数据。

## 0.3.0 Agent resume · 2026-11-17

Windows 独立验收窗口完成 10 次真实重载及 50 次重新绑定；持久 mapId 始终相同，运行 id 每次更新。另用两个同名 Core／relay 地图交替绑定 50 次、替换实例 10 次，核对旧订阅与游标回收。提交确认丢失、helper 实际退出、主动断开、取消清理、包命令中断等由定向检查承接。

`node --expose-gc --import tsx scripts/profile-resume.mjs <output.json>` 使用 Linux 临时 fixture，记录如下：

| 轮次 | MCP RSS | MCP 线程／FD | 宿主 GC 堆 |
|---|---:|---:|---:|
| 10 | 18.14MiB | 2／7 | 8.34MiB |
| 20 | 18.14MiB | 2／7 | 8.33MiB |
| 30 | 18.14MiB | 2／7 | 8.33MiB |
| 40 | 18.14MiB | 2／7 | 8.36MiB |
| 50 | 18.14MiB | 2／7 | 8.37MiB |

每轮只有目标地图保留一个客户端。关闭后两图的客户端、订阅、pending、relay、游标、监听、runner 与路径锁均为零。MCP 连接期间使用阻塞读取，目录通知只负责等待阶段的唤醒。

四端连接、画布全局视图静置 **600.06 秒／41 个样本**。第 60 秒至结束的 Webview TaskDuration CPU 占比约 0.035%，共享宿主约 0.081%；这段每 15 秒主动查询四端资源和诊断。Webview heap 为 4.54→4.62MiB，宿主 RSS 原始值为 131.77→37.41MiB。WSL／训练机／推理机 helper 的 RSS 分别约 19.04／22.97／17.69MiB，CPU 占比约 0.0069%／0.0024%／0.0038%。整个阶段运行任务、路径锁、借出缓冲和恢复等待器均为零，包子进程为零。

再固定到 WSL 家目录、一个监听分支，按 0.2.0 的方式只读取首尾资源，静置 60 秒。UI 根目录与监听数前后相同：

| 项目 | 0.2.0 | 0.3.0 |
|---|---:|---:|
| Webview TaskDuration CPU | 0.037% | 0.046% |
| 共享宿主 CPU | 0.025% | 0.025% |
| Webview JS heap | 5.39MiB | 4.81MiB |
| 宿主 RSS 原始值 | 63.0MiB | 38.9MiB |
| 16MiB 复制＋回读核对，当前对照 | 14.95s | 13.32s |
| 复制阶段墙钟 | 10.50s | 6.57s |
| 复制及回读期间目录响应 p95 | 15.19ms | 10.91ms |

CPU 按单核累计时间计算，Webview 使用 CDP TaskDuration，宿主使用原生端点的 process.cpuUsage。共享宿主含 VS Code 内置扩展，RSS 受 Windows 页面回收影响；堆与 RSS 保留场景观测值，回收稳定性由循环计数及 GC 堆判断。

传输对照在同一验收窗口分别加载官方 0.2.0 和本轮 0.3.0，使用相同 16MiB 内容、Windows 源、训练机目标及 WSL 目录查询；每次创建独立 fixture。0.2.0 同日历史样本为 4.80 秒，当前重测为 14.95 秒，因此本轮使用当前对照。单轮数值承接这次实际环境，后续调优继续按相同场景重测。

另将 **64MiB Windows→训练机复制在 4MiB 检查点后重载窗口**：原任务自动接续，包含重载共 33.00 秒，SHA-256 一致，原任务收据保持同一 ID；期间 469 次目录查询 p95 约 5.97ms。结束后传输租约、借出缓冲、运行任务及路径锁均归零。独立 Codex／dsh 实际会话均查询到该原任务为 completed；临时配置退出后清除，原授权保留。

数据：[50 轮生命周期](docs/performance-data/20261117-resume/lifecycle.json)、[Windows 采样与传输对照](docs/performance-data/20261117-resume/windows.json)。Windows 完整原始日志留在本机 artifacts/acceptance-030；公开记录保留场景、版本及资源数值。测试只操作独立 fixture，完成后删除。
