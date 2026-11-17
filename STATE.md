# Workspace Map · 0.1.1

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

本机另有 `github` remote 指向 `jiale-li-orion/Wayfarer`，本轮交付通过训练机主仓库和 VSIX 完成；GitHub 发布、Marketplace 发布分别处理。
