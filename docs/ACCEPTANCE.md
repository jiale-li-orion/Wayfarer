# 0.2.0 实际机器验收

2026-11-17，Windows VS Code 1.146.0 + Ubuntu WSL；Linux SSH：训练机、推理机（Python 3.6.8）。独立 user-data-dir 与 extensions-dir；Copilot 关闭。

| 范围 | 实际结果 |
|---|---|
| Windows／WSL／训练机／推理机家目录 | 目录分页、路径属性、项目与缓存位置查询通过；真实家目录只读 |
| 工具版本任务 | 初轮四端分别发现 8／8／3／2 个命令；补齐 SDK 固定位置发现后，最终安装版在 WSL 查询到 10 个命令，包含 Flutter 与 sdkmanager。Windows python3 应用别名退出 9009，python 正常；单个版本查询保留实际退出码 |
| 文件与项目 | 临时 Windows 项目识别、登记、占用统计通过；16MiB 文件复制到训练机并按 SHA-256 核对 |
| UI 与离线隔离 | 离线 SSH 的详情错误局限于该端点；WSL 浏览正常。详情开关 30 次并 GC 后监听数 254→254，关闭降为 234 |
| 任务恢复与历史 | 1,003 条旧 journal 定向测试覆盖迁移、两页无重叠、详情读取、暂停任务重启；原传输暂停恢复、取消和源变化用例继续通过 |
| 包管理已有覆盖 | 0.1.1 的隔离 uv／pip／npm／pnpm／bun 查询、安装、卸载和取消记录继续保留；Java、Gradle／Maven 缓存 fixture 通过 |
| 升级与回退 | 独立窗口从 0.1.1→0.2.0→0.1.1→0.2.0；书签、展开、镜头与暂停任务恢复通过，4MiB 传输恢复后内容核对一致 |
| Agent | 实际 Codex／dsh 会话读取 endpoints、inspect、jobsPage 并 navigate；保持指定会话，跟随关闭，原有授权配置保留 |
| Android／Flutter／winget | 指定已安装管理器实际完成 SDK 清单、Flutter 3.44.8 信息、winget 软件清单查询；全局安装／升级使用原配置，仅做命令计划检查 |
| 自动检查 | 训练机 34 项测试及 TypeScript 检查通过；Linux／Windows CI 已通过；Windows 执行 portable 子集，真实四端链路按本表单列 |

流水线检查覆盖源码与隔离 fixture；真实端点、账号权限、网络及已安装工具以本表和 PERFORMANCE.md 的对应日期为准。后续版本更新实际覆盖结果与运行记录。

## 0.3.0

- Linux 48 项定向检查与类型检查通过；Windows portable 检查、构建打包由 PR CI 执行。覆盖 receipt 去重与确认丢失、checkpoint 接续、快速继续、真实 helper 断开、主动断开、暂停、取消及清理失败重试、旧任务、旧版分页、迟到游标、阻塞 worker 退出、包命令实际退出状态。
- 两个同名 Core／relay 地图完成 50 次切换；同一客户端完成 10 次实例替换。Windows 安装窗口完成 10 次真实重载及 50 次绑定，mapId 保持相同，runtime id 更新。
- Windows、Ubuntu WSL、训练机、推理机目录读取通过。64MiB 文件传输中重载自动接续，任务 ID、SHA-256 和源文件结果符合预期；完成后清理 fixture。
- 主动暂停、主动断开、取消、旧版无原因记录、权限与源变化沿各自分支处理。包命令取消后保留实际输出和退出状态，重开及相同 operationId 查询沿用原结果。
- 实际 Codex／当前 dsh headless profile 完成 connection、endpoints、jobsPage 与原任务 operation 收据查询；原全局授权保留，临时 overlay 已撤回。
- 50 次绑定的 RSS、GC 堆和资源计数稳定；完整 600 秒待机、60 秒旧版条件对照、16MiB 复制与回读对照已记录于 PERFORMANCE.md。独立验收窗口临时回退 0.2.0 完成当前对照，最后沿 0.3.0 Release 升级。

## 0.3.1 侧边栏与快捷键（2026-11-17）

Windows VS Code 1.146.0 独立验收窗口安装候选 VSIX，活动栏图标、侧边栏的机器／书签／常用操作均已呈现。

| 场景 | 结果 |
|---|---|
| 点击 Windows C、Ubuntu WSL、训练机 | Core 当前路径与所选机器根目录一致，地图显示对应目录 |
| 添加书签、点击书签、移除书签 | 侧边栏随共享 ViewState 刷新，定位 `/home/orion` |
| 全局地图／侧边栏快捷键 | Ctrl+Alt+M、Ctrl+Alt+Shift+M 生效 |
| 地图内搜索、任务、返回、前进、上一级 | 快捷键打开对应面板／定位对应历史路径 |
| 关闭地图后点击后台任务 | 新地图加载后任务面板打开 |
| 切到文本编辑器后点击搜索 | 恢复地图并打开搜索面板 |
| 连续 20 轮侧边栏／地图切换 | 目录与任务归属计数保持稳定 |
| 推理机点击连接 | 本轮出现 WSL 子进程退出码 4294967295；地图与其他机器继续响应。Linux 直连 SSH 可达，记录为本轮 Windows 桥接验收缺口 |

原始 UI 状态和截图保存在本机 `artifacts/acceptance-031/`。训练机类型检查、48 项检查和 VSIX 打包通过。本轮使用现有真实目录只读导航，后台操作与传输继续沿 0.3.0 的验收记录。

## 0.4.0 四端资源

58 项检查与跨平台子集 13 项通过。Windows／Linux CI 执行独立矩阵。

- 四端实际 GPU 数量核对为 Windows 2、WSL 1（与 Windows NVIDIA 相同 UUID）、训练机 8、推理机 1。Windows 实测 PDH 三组独立收集，网络接口 2 个、磁盘吞吐源 1 个；4 个卷容量可读。
- 四端总览记录约 643 秒、50 轮真实标签切换、隐藏待机约 639 秒。通道／请求／定时器归零，采集 PID 退出。
- Windows 原生保存对话框完成 JSON（4 机器快照）与 CSV 实际保存。关闭／重开窗口后，历史 JSONL 经原生文件选择与保存对话框导出为 259 条有效 JSON 记录。
- 单独断开训练机后返回该机离线状态，推理机保持在线；重连训练机恢复八卡指标。进程退出／身份变化局限在所选对象，当前 PID 与权限受限分支由实际采集及定向检查覆盖。
- Codex 与 dsh 实际模型回合各调用一次 map_systemResources，只读取得训练机八卡与推理机单卡结果。测试使用临时绑定覆盖，原模型与授权策略保留。
- Windows／WSL／两台 SSH 的文件访问、双目标 8MiB 复制、逐块 SHA-256 回读，以及监控关闭／明确后台记录两种场景的目录响应通过。两轮测试目录均已删除。

[资源链路与接口](SYSTEM_RESOURCES.md) · [性能与条件](../PERFORMANCE.md)

## 0.5.0 常用工作区与项目环境

独立 Windows 验收配置位于 D 盘，保留日常窗口和配置。Windows／WSL／训练机／推理机完成真实环境声明、工具发现及 Python 生态版本查询。推理机保持 Python 3.6.8，现有环境与业务服务沿原配置；其当前账号尚未发现 uv，界面据实返回可用工具。Windows、WSL、训练机均发现实际 uv 路径。

- 51 轮真实环境页打开／关闭后，面板计数逐轮归零，Inspector pending 为零，缓存保持有界。一次命令面板时序和测试窗口定位失败已定位到验收脚本；改用等待命令结果及侧边栏／标签关闭按钮后补齐验收。
- 原生目录加入当前工作区后显示两个根目录；切换 `.code-workspace` 后 mapId 独立，三个收藏跨工作区保留；再次点击当前工作区只聚焦，运行实例保持。
- 打包后的 JSONC 解析问题已修复，并增加 CommonJS 打包产物回归；从收藏的已有工作区文件读取当前两个根目录通过。
- Codex exec 与实际 dsh headless 各调用一次 `map_workspaces` 并返回收藏清单；临时覆盖配置只作用于验收进程。原有账号、模型、授权和持久 profile 保留。
- uv 0.9.22 在隔离虚拟环境中，通过本地 wheel 完成 add → locked sync → list → 指定依赖 lock 更新 → remove → locked sync；核对声明、锁文件、实际导入和删除结果，临时环境已释放。

原生 WSL／SSH 打开委托用户已有 Remote 扩展与连接配置；本轮实机验证原生 Windows 工作区切换、四端文件／环境访问和 Remote URI 解析。新窗口额外实例与原生远端 IDE 启动未在本轮低内存环境展开；其菜单调用沿公共 `vscode.openFolder` 接口。同窗口约 615／619 秒串行待机对照已完成，缓存与任务计数稳定；含共享宿主、renderer、GPU 进程的原值见 PERFORMANCE.md。

最终补齐 Java 缓存位置与路径归属展示，Windows 实机核对 Java 页和 cache 数组通过；切换生态后版本清单按各自查询来源展示。71 项 Linux 定向检查、25 项 portable 子集及 Python 3.6 语法检查通过；PR 最终 CI 运行记录与发布制品由 GitHub 保留。
