# VS Code 日常环境精简与资源记录

## 已执行的处置

Windows 注册清单 61 → 49 项，WSL 9 → 7 项；合计移除 12 种扩展的 14 份安装。账号、会话、模型和项目内容保留。Windows 中已标记卸载的 12 个包目录另行核对注册状态后清理，回收 459,241,146 字节（约 438 MiB），扩展用户数据保留。

| 扩展 | 处置 | 依据 |
|---|---|---|
| Kimi、Qwen | Windows／WSL 均卸载 | 用户明确停用，日常使用 Codex／dsh |
| CodeTour、Cline Chinese | 卸载 | 用户停用；Cline 原已禁用 |
| Markdown Mermaid | 卸载 | 已弃用，现版本 VS Code 内置渲染器 |
| Git Graph 3 | 卸载 | 保留 Git Graph Libre 与内置 Git |
| Paste Image | 卸载 | 关闭该扩展后，内置 Markdown 在 WSL fixture 创建 92 字节 PNG 并插入图片引用 |
| GitDoc | 卸载 | 自动 commit／push／pull 的行为与当前明确管理提交的工作流分离 |
| GitHub Projects、Gitea 登录 | 卸载 | 现有工作流使用 PR／Issue／CLI，未观察到 Agent 消费链 |
| C/C++ Compile Run、PowerShell Inline Values | 卸载 | 单文件运行／手动调试的界面包装；保留底层语言、编译和调试能力 |
| Copilot | 停用内置业务入口 | 独立安装清单无对应包；设置 chat.disableAIFeatures=true，核对新窗口停止激活，保留通用工具 API |
| Python、C/C++ 服务，文档与编辑工具 | 保留 | 编辑／语义及待接 Agent 工具组件 |
| Edge Tools、Dev Containers、Remote Tunnels | 保留按需能力 | 本轮保留专业生态接口，不将静态安装直接算作高 CPU |

支持的 vscode-icons 设置 `vsicons.projectDetection.disableDetect=true` 已应用。原故障可用临时 WSL fixture 复现：插件尝试读取 Windows `D:\tmp\…\package.json`；关闭项目识别后图标扩展在新窗口正常激活，文件图标保留。删除两项失效的 Fitten Code 语言偏好。

当前科研工作区只增加搜索／监听排除：node_modules、target、.gradle、__pycache__、.venv／venv，以及确认的 Android build 输出。文件树保持可见，`.local` 整体保留；本地两个登记 worktree 也保留，只排除其 target 构建产物。

Codex 的 Wayfarer MCP 原来仍指向旧 runtime session，重载后失效。已只将这一服务的 args 改为当前官方助手与稳定 mapId；其他 TOML 值逐项比较一致。当前客户端重新连接同一地图，Windows／WSL／训练机／推理机目录读取通过。

另外关闭了此前保留的 `acceptance (Workspace)` 验收实例。关闭前核对运行任务为 0、未保存标签为 0；该实例 19 个进程的私有提交量合计约 1,003.54 MiB。这是额外验收实例的回收，单列于插件收益之外。当前工作窗口和会话继续运行。

## 对照条件与结果

Windows VS Code 1.146.0、同一 WSL 工作区及临时 TS／Python／Markdown fixture、同一开发探针。隔离 user-data 目录复用已安装扩展，候选状态先通过禁用参数验证，再执行日常卸载；两次各执行 12 轮相同定义／引用／缓冲区修改，随后记录约 60 秒。探针自身只有一个控制目录监听；所有 fixture 编辑均保存恢复后的原文。

| 指标 | 基线 | 精简候选 |
|---|---:|---:|
| Windows UI 扩展宿主私有内存中位数 | 122.24 MiB | 126.61 MiB |
| Windows UI 扩展宿主 CPU（单核百分比） | 0.026% | 0.026% |
| WSL 扩展宿主 PSS 中位数 | 413.95 MiB | 263.01 MiB |
| WSL 扩展宿主 RSS 中位数 | 463.60 MiB | 316.02 MiB |
| WSL 扩展宿主 CPU（单核百分比） | 2.846% | 5.336% |
| WSL 扩展宿主末次 FD | 70 | 68 |
| 第 3–12 轮操作中位数 | 97.38 ms | 105.05 ms |
| 第 3–12 轮操作最大值 | 712.24 ms | 167.02 ms |

该场景下 WSL 宿主 PSS 降约 151 MiB；Windows 本地宿主持平，CPU 原值如表。该表反映这一工作区、宿主和采样窗口；整体 IDE、逐插件归因及长期稳态分别测量。首轮两边都曾在语言服务初始化时返回空列表，之后每轮返回 1 个定义和 2 个引用；初始化与稳态结果分开解释。

候选 WSL 宿主追加 20.16 秒 CPU profile：约 19.64 秒处于 idle，`findCandidatePorts` 含子调用约 171ms（约占该段总采样时间 0.85%），另有进程启动及文件状态读取。后续 CPU 优化优先核对自动端口发现及 /proc 扫描；当前保留自动转发行为。CPU profile 的完整 URL／路径记录保留于本机产物目录，摘要见 performance-data。

数据只归属于标明 PID 的宿主；Windows RSS、私有提交量和 Linux PSS 分开列出。采样窗口内未向模型发起推理请求，Codex 活跃对话的内存另由日常工作窗口承担。

## 验证与恢复

- TypeScript：12 轮临时编辑及现有语言提供者查询通过，预热后返回正确位置。
- 停用 Copilot 后，通用工具目录保留 21 项；只读调用既有代码用途工具返回测试符号的 2 个位置，耗时约 41ms。
- Codex 安装和当前主对话保留，独立窗口仍显示 Codex 入口；dsh headless CLI 启动检查通过，本轮未额外请求 dsh 模型。
- 地图四端读取通过。测量窗口的 UI／WSL 扩展宿主退出情况记录在本机 cleanup.json。
- 图片插入通过；剪贴板恢复探针误把 Windows 自动增加格式识别成用户修改，原剪贴板未恢复。已按完整像素内容匹配后清除测试图片，移除该一次性脚本。工作文件、账号与会话不受影响。后续图像剪贴板验收使用可丢弃桌面会话或同时核对内容所有权。

恢复扩展可使用同一安装位置的 `code --install-extension <id>@<version>`；之前的 ID／版本在本机执行前 inventory.json，卸载结果和回收字节数在本机执行记录。Copilot 与图标识别设置可分别撤销；扫描排除只影响当前工作区。恢复时保留现有账号／模型配置。

## 记录与后续评审

本机完整产物：`artifacts/environment-audit-20261118/`。仓库保留资源摘要与开发探针，`scripts/**` 排除于 VSIX；本轮产品源码与公共 API 保持现状。

下一阶段评审见 [共享环境方案](SHARED_ENVIRONMENT_REVIEW.md)：优先复用 Codex 已有实验 LSP MCP，再核对 VS Code 公共工具 API、语言服务宿主、缓冲区版本和跨 harness 消费方式。

## Windows／WSL 全进程复核

补齐日常 Windows 进程树与 WSL 同步采样：Windows 私有提交量中位值约 2220 MiB，WSL 编辑器与 Agent 相关进程 PSS 约 1061 MiB。最大开销集中于 Windows 渲染进程与 WSL 扩展宿主／Codex；本地另有 Kotlin／Gradle 构建进程。两项界面动画配置及连续采样结果见 [双端资源复核](WINDOWS_WSL_RESOURCE_AUDIT.md)。这是 Agent 活跃期间记录，和上文独立窗口的短时待机对照分别解释。
