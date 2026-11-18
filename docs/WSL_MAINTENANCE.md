# Windows 离线交换文件维护

入口源码为 scripts/windows-wsl-maintenance.py、同名 ps1 与 cmd。Python默认预览；cmd明确执行离线维护。操作范围限定为已确认清单中的 Windows Temp/GUID/swap.vhdx，现役交换文件、系统VHD、重解析点和共享文件各自保留。普通文件管理的回收站语义保持原状，这个独立维护入口会永久回收选定的遗留交换文件。

## 预览与执行

在Windows使用实际原生Python运行预览，传 --manifest 原清单、--swap-file 现役交换文件、--prepare swap-files-ready.json。预览记录卷／文件ID、长度、100ns修改时间和解析路径，支持Windows短文件名与完整路径映射，文件ID继续按原值核对。验证独占句柄后关闭，保留源文件。准备清单同时记录原生Python路径，启动入口沿用这一执行环境。Get-DiskImage以单个PowerShell进程批量查询，完整记录HRESULT、类型和错误文字，作为辅助诊断。

结束WSL任务、Agent会话及相关窗口后，从Windows双击维护cmd。启动器读取准备清单，提升权限、等待Python进程并传递真实退出状态。执行识别已经存在且配置一致的目标交换文件，保留该文件与所有其他WSL设置；配置存在歧义或目标归属不一致时报告失败。

执行只在WSL停止后处理候选项。每项从独占句柄取得当前身份，核对准备清单，再次检查WSL状态，通过同一句柄设置删除标记，最后关闭句柄。Windows共享语义阻止普通读写与删除句柄冲突；文件被替换、数据变化、受占用、权限不足或重解析路径均保留并记录。运行中观测到WSL重新启动时立即停止余下处理，记录发行版及未处理条目。

每次显式运行产生独立JSON报告，wsl-maintenance-result.json指向最新结果。报告包含逐项状态、删除字节数、实际卷余量、停止原因和退出码。退出码0表示预览或全部完成，1表示部分完成，2表示被WSL重启或权限前置条件阻断，3表示输入、配置或运行失败；outcome区分preview/completed/partial/blocked/failed。重跑会保留已配置的目标交换文件，已消失的旧文件记为already-absent。

## 本机记录（2026-11-18）

现役路径为F:/WSL/swap.vhdx，WSL维持10GiB内存与原交换容量。53份旧文件约75.24GiB已完成真实身份预览；另1份在先前WSL退出时消失。先前Get-DiskImage前三项报错，随后WSL重启，原维护脚本中止；旧报告仅保留退出码。新入口具备完整诊断和独占句柄处理路径，实际离线回收与重启检查留待当前会话结束后执行。

部署文件与原始记录位于 D:/Wayfarer-Acceptance/storage-audit-20261118，验证产物位于 D:/Wayfarer-Acceptance/offline-swap-20261118。离线完成后核对C/F盘余量、swap使用、项目、SSH、Wayfarer及Agent。80GiB余量为目标，以实际卷采样与逐项结果验收。
