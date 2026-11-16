# Workspace Map
先读 ARCHITECTURE.md 和 STATE.md。开发在训练机独立 worktree，本机用于 VSIX 验收。
保持真实文件身份和端点权限；真实移动通过专用手柄或明确操作入口。
目录浏览与后台任务独立；无启动时递归扫描；所有持久状态在 globalStorage 或用户权限 IPC 目录。
测试文件操作使用临时 fixture；包修改使用独立环境。保留用户现有配置。
