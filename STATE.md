# Workspace Map · 0.11.0

训练机主仓库 /data/users/lijiale/projects/agent-system-learning/workspace-map；本机镜像 /home/orion/agent-system-learning/workspace-map。开发在训练机独立工作树，本机安装与验收，产物留D盘。

C盘离线维护已完成：53份旧交换文件回收75.24GiB，完成时C盘余量约98.7GiB；现役F盘交换文件、10GiB内存及原配置保留。用户确认旧项目后，SecFusionAgent的14个容器和OpenViking旧自启动容器已移除，业务卷保留。后续采样及原始结果位于D:/Wayfarer-Acceptance/post-cleanup-20261118。

本轮统一收藏入口并迁移地图书签，明确文件名搜索／后台任务／诊断日志；增加SSH首次登录、专用密钥配置与命名。补受限VM进程内存来源、离线地图及时响应及Agent精简返回。实现边界见ARCHITECTURE.md，入口说明见README和docs/SSH.md；性能与验收结果归PERFORMANCE.md和docs/ACCEPTANCE.md。

本轮增加收藏查询条件、搜索结果归属、共享 SSH 机器及首次授权接续。工作区只读盘点、明确归属的迁移、缓存与性能复测记录位于 D:/Wayfarer-Acceptance/workspace-20261119。

0.8.0 在训练机 2 的独立 worktree 开发。资源页增加多机对照、私网链路检查与短时测速、文件传输时间线及外部作业运行报告。当前窗口地图绑定入口复用 Codex／dsh 接入。0.8.0 已正式发布。

0.9.0 在训练机 2 独立 worktree 开发，增加服务器直传、巡检组和地图绑定状态。

0.10.0 新增模型分析页和只读 map_modelAnalysis。Windows 本机已安装验收，CPU 小模型回放验证了两种 loss 归约、梯度累计和有效权重变化。实验端输入格式与使用入口见 [模型分析](docs/MODEL_ANALYSIS.md)。

0.11.0 将机器总览和巡检合并，在作业详情关联模型回放、耗时和传输。生产端状态与进程身份分别记录。入口与兼容协议见 [作业说明](docs/WORKLOADS.md)。
