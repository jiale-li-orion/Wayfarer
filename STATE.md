# Workspace Map · 0.7.0

训练机主仓库 /data/users/lijiale/projects/agent-system-learning/workspace-map；本机镜像 /home/orion/agent-system-learning/workspace-map。仓库 jiale-li-orion/Wayfarer，显示名称 Workspace Map。训练机独立工作树开发，本机安装验收，产物留 D 盘。

## 本轮

先完成存储整理闭环，再追踪 Windows／WSL CPU 与内存。容量刷新按可见性和相关任务事件合并；同目录快照对比使用 SQLite 分页，展示覆盖差异并支持导出。三份／100 MiB 预算保留，淘汰原因以有界元数据交付。

共享资源采样增加 Windows 系统提交量、分页文件大小、Linux PSI／换页／OOM 和 WSL 承载预算。记录每机器十秒一份，默认十分钟／20 MiB 自动结束，支持本机独立记录根目录并按地图隔离；隐藏后最后一个使用者退出即释放助手。接口与生命周期见 docs/STORAGE.md、docs/SYSTEM_RESOURCES.md；架构沿 ARCHITECTURE.md。

## 维护与交付

交换文件重新核对为 54 份约 75.5 GiB，F 盘约 47 GiB 余量。当前普通权限下 5 份显示未挂载、49 份查询拒绝访问；Windows 管理员离线维护入口会在 WSL 停止后逐项核验。维护入口和清单位于 D:/Wayfarer-Acceptance/storage-audit-20261118。当前 WSL／Agent 会话继续运行，交换文件处理和重启验证由离线时段承接。回收站、业务资料、环境、模型和系统 VHD 保留；WSL 10 GiB 与系统分页策略沿用。

交付核对：npm run typecheck、npm test、npm run test:portable、Python 3.6 语法、Windows／WSL 实测、同场景采样。结果归 PERFORMANCE.md 与 docs/ACCEPTANCE.md，原始记录留 D 盘。交付后同步两个主仓库并清理开发工作树。
