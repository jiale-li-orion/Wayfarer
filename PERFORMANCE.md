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
