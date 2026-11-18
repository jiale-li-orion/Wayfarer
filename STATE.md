# Workspace Map · 0.7.0

训练机主仓库 /data/users/lijiale/projects/agent-system-learning/workspace-map；本机镜像 /home/orion/agent-system-learning/workspace-map。GitHub jiale-li-orion/Wayfarer，显示名称Workspace Map。训练机独立工作树开发，本机安装与验收。

当前插件0.7.0已安装并生效。存储刷新／对比、内存压力与有界录制沿原Core工作；本轮修改独立维护入口和测量工具，运行接口保持现状。

现役交换文件已切到F:/WSL/swap.vhdx，WSL内存10GiB与原交换容量保留；53份旧交换文件约75.24GiB仍待离线回收。新维护入口支持现役文件存在时重跑、身份清单、独占句柄删除、完整诊断和真实退出状态，说明见docs/WSL_MAINTENANCE.md。当前WSL/Agent会话继续运行，正式停机与重启验证由离线阶段承接。

Windows原生隔离测试覆盖删除、占用、替换、junction、重跑、部分失败、WSL重启与启动器退出传递。真实清单预览保留53份源文件，另1份已消失。Windows/WSL进程归组与页面对照数据留D:/Wayfarer-Acceptance/offline-swap-20261118；用户应用与其他业务进程按现有职责运行。交付后同步主仓库、清理本轮工作树。
