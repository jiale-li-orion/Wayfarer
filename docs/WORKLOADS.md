# 机器与作业

活动栏打开目录地图。机器节点连到各自真实文件系统，CPU、可用内存、逐卡利用率与可用显存直接显示在节点内。选择两台 SSH 主机的配对图标后，在同一详情栏打开共享挂载与链路诊断。机器别名与 Windows 各盘符沿用物理机器分组。

## 登记一次外部运行

在进程详情点「加入作业」可关注当前进程。实验脚本或 Agent 通过绑定到该地图的 MCP 客户端调用 `map_workloadRegister`。同一地图内使用稳定的 runId；各 rank 和恢复后的 segment 用同一 runId 追加文件。endpoint 使用 `map_endpoints` 返回的 ID。示例参数：

```json
{
  "runId": "audio-study/run-42",
  "name": "语音模型 · LoRA 对照",
  "endpoint": "train",
  "phase": "训练",
  "projectRef": {"endpoint":"train","path":"/experiments"},
  "statusPath": "/experiments/run-42/status.json",
  "files": [
    {"kind":"model","endpoint":"train","path":"/experiments/run-42/rank-0/segment-a/run.json","label":"Rank 0 · 第一次启动"},
    {"kind":"profile","endpoint":"train","path":"/experiments/run-42/timing.json","label":"耗时"},
    {"kind":"log","endpoint":"train","path":"/experiments/run-42/train.log","label":"训练日志"}
  ]
}
```

运行可以直接调用同一接口提交新的 phase、step、state。另一个选择是把状态写进已登记的 statusPath，适合独立 SSH 会话和窗口关闭期间继续训练的情况。实验端使用临时文件加原子改名发布 UTF-8 JSON（最多 8 KiB）。例如 `{"runId":"audio-study/run-42","state":"running","phase":"训练","step":42,"updated":1795000000000}`。updated 为生产端递增的 Unix 毫秒时间。新进度沿用原来的文件关联；成功、失败、退出分别写 completed、failed、exited。进程身份核对还会区分 PID 复用、退出、离线和观测暂不可读。

| MCP 工具 | 用途 |
| --- | --- |
| map_workloadsPage | 分页看已登记运行。当前页的进程和状态文件按机器合并读取，observe=false 仅读目录索引。 |
| map_workloadDetail | 按 runId 查看文件、阶段、最后观测，observe=true 请求新读数。 |
| map_workloadRegister | 登记或更新运行；files 按类型、端点、路径去重。 |
| map_workloadForget | 清除这张地图的关注记录，外部进程、文件和已接受的传输继续由各自的所有者管理。 |
| map_transfer | 提交复制／移动时可传 workloadId、workloadPhase，把任务归入某阶段。 |
| map_jobsPage | kind=transfer 可查看文件传输，加 workloadId 只取该运行的关联传输。省略过滤条件沿用完整任务列表。 |

可选 projectRef 指向运行机器上的实际项目目录。运行与产物保留原端点身份。旧运行归到机器，最近结束的运行按归属折叠。点击实验名直接打开唯一报告；有多份时打开同一个详情栏选择，旁边的「⋯」始终打开详情。文件传输对话框可选「关联作业」。独立复制、移动在「更多 → 文件传输」查看和恢复。后台搜索、清单与统计沿原入口查看。历史记录和导出位于「更多」。

## 资源归属

目录位于当前地图的 globalStorage/workloads.json。打开作业列表只读取当前页，打开详情才取记录正文和相关传输。可见页面每十秒刷新一次，同一轮对同一机器只发一份身份和状态查询。隐藏页签后释放页面定时器；已发出的单次读取结束后回收通道，迟到结果由原视图丢弃。机器断开时保留最后一次确认的状态。独立进程退出仅说明该进程结束，实验结论取生产者写出的终态。
