# 0.2.0 实际机器验收

2026-11-17，Windows VS Code 1.146.0 + Ubuntu WSL；Linux SSH：训练机、推理机（Python 3.6.8）。独立 user-data-dir 与 extensions-dir；Copilot 关闭。

| 范围 | 实际结果 |
|---|---|
| Windows／WSL／训练机／推理机家目录 | 目录分页、路径属性、项目与缓存位置查询通过；真实家目录只读 |
| 工具版本任务 | 四端分别发现 8／8／3／2 个命令。Windows python3 应用别名退出 9009，python 正常；单个版本查询保留实际退出码 |
| 文件与项目 | 临时 Windows 项目识别、登记、占用统计通过；16MiB 文件复制到训练机并按 SHA-256 核对 |
| UI 与离线隔离 | 离线 SSH 的详情错误局限于该端点；WSL 浏览正常。详情开关 30 次并 GC 后监听数 254→254，关闭降为 234 |
| 任务恢复与历史 | 1,003 条旧 journal 定向测试覆盖迁移、两页无重叠、详情读取、暂停任务重启；原传输暂停恢复、取消和源变化用例继续通过 |
| 包管理已有覆盖 | 0.1.1 的隔离 uv／pip／npm／pnpm／bun 查询、安装、卸载和取消记录继续保留；Java、Gradle／Maven 缓存 fixture 通过 |
| 自动检查 | 训练机 34 项测试及 TypeScript 检查通过；Windows CI 执行 portable 子集，真实四端链路按本表单列 |

流水线检查覆盖源码与隔离 fixture；真实端点、账号权限、网络及已安装工具以本表和 PERFORMANCE.md 的对应日期为准。后续版本更新实际覆盖结果与运行记录。
