# Workspace Map · 0.2.0

CPU／内存优化与实际使用验收完成。训练机主仓库：`/data/users/lijiale/projects/agent-system-learning/workspace-map`；本机源码镜像及 VSIX：`/home/orion/agent-system-learning/workspace-map`。继续开发时在训练机建立新工作树，本机用于安装验收。

## 当前实现

- 目录回复按请求归属交接，收起后的迟到游标回收；画布隐藏后保留编辑器独立监听。
- 分支通知按 150ms 合并，原生目录属性每批并发 16 项；离屏缓存同时限制分支数量与条目数量。
- 覆盖／跳过操作锁定具体目标，独立文件可以并行；自动改名保留目录锁。
- SSH／WSL 传输租用独立数据通道，最后一个任务释放时退出；目录、编辑和包任务使用控制通道。
- 小文件最多四个并行，整个任务最多四块 1MiB 缓冲；暂停恢复继续核对源、分片和提交结果。
- `map_diagnostics` 提供插件自身资源计数，`map_resources` 提供进程与通信计时；当前 dsh bundle profile 使用 `cordis.patch.yml`，依赖目录从 profile 选项中排除。

## 验证与边界

28 项测试与 TypeScript 检查通过。Windows 安装版完成 160 次导航、两个 64MiB 并行传输、摘要核对、小文件传输、取消、隐藏和关闭地图。四端连接、四端展开、连续隐藏各完成 600 秒采样；空白 VS Code 对照采样 180 秒。最后一轮隐藏的 40 个样本监听始终为零；窗口关闭后三个远端／WSL 助手按 PID 确认退出。

实际 dsh headless 完成读取、定位、复制、任务查询和回读。Codex 的只读验收会话通过读取／定位，写入请求按会话授权策略被拒绝；既有授权配置保持原样。uv／pnpm／bun 临时包安装、查询、卸载和 npm 安装取消通过；Java 查询、Gradle／Maven 测试缓存操作通过，当前环境的 cargo／rustup 未运行。

性能结论、范围与复测入口见 [PERFORMANCE.md](PERFORMANCE.md)，结构与生命周期见 [ARCHITECTURE.md](ARCHITECTURE.md)。原始记录仅保留有效样本，版本对应关系见 [provenance.json](docs/performance-data/20261117/provenance.json)。最终构建身份写入 VSIX 的 `dist/build-info.json`，安装回执位于本机 `artifacts/delivery.json`。

GitHub 仓库为 `jiale-li-orion/Wayfarer`。训练机主仓库和本机镜像沿 main 同步；GitHub Release 交付 VSIX、摘要和提交身份，Marketplace 发布另行安排。


## 0.2.0 日常管理变更

功能分支 `feat/daily-management` 增加按需详情、浅层项目识别与登记、工具版本任务、缓存／环境位置与占用统计、历史任务磁盘分页。查询快照限制为 64 项／8MiB，资源查询手动发起，面板任务订阅按引用计数释放。新增 3 项定向测试，连同原有检查共 31 项通过。Windows／WSL／训练机／推理机家目录只读详情已通过；真实文件操作使用临时 fixture。当前验收与性能原始记录见 `docs/performance-data/20261117-management`，发布维护由 PR #2 一并交付。


## 发布维护交付

- 功能 PR：https://github.com/jiale-li-orion/Wayfarer/pull/1；发布维护 PR：https://github.com/jiale-li-orion/Wayfarer/pull/2。按 #1→#2 顺序进入 main；#1 同时交接原 0.1.1 提交。训练机主仓库、本机 main 和 GitHub main 使用同一提交，发布标签指向通过检查的 main 提交。
- 发布维护包含 Windows／Linux PR CI、标签发布、构建身份与 SHA-256、升级回退说明和内容哈希隔离的 MCP 助手。扩展显示名称 Workspace Map，仓库名称 Wayfarer。最终 VSIX 的提交身份见 artifacts/release.json。
- 训练机 34 项检查通过，Linux／Windows CI 通过。四端工具清单、Android／Flutter／winget 只读查询、Codex／dsh 新接口及升级恢复均完成。性能对照见 PERFORMANCE.md；当前实机覆盖见 docs/ACCEPTANCE.md。
- 开发工作树在交付后清理；后续从 main／发布标签建立新工作树。当前代码镜像与交付文件保留于本机 workspace-map 仓库。Marketplace、Agent 跨会话重连与协同整理沿后续需求处理。
