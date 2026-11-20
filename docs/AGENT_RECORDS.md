# Agent 的实验交接、取数和导出

先由 Agent 调用 `map_registerProject({ref:{endpoint,path}})` 接入项目。在实验机器上使用 Python 3.6+ 标准库脚本登记运行，编辑器关闭期间也可执行：

```sh
python3 scripts/index-workload.py --project /experiments/audio --run-id audio/run-42 \
  --name '语音模型 · 对照' --status-path outputs/42/status.json \
  --file model outputs/42/rank-0/segment-a/run.json --file profile outputs/42/timing.json
```

每个项目的 `.wayfarer/runs/<sha256(runId)>.json` 保存一个 `wayfarer.run/1` 条目。并发写入使用每次运行独立的锁和原子替换。新增 rank 或 segment 时再次调用并追加文件引用。相对路径从项目目录解析，绝对路径位于执行端点。在线登记使用 map_workloadRegister，可追加其他端点的产物。地图重开只检查已登记项目的固定索引目录，并分页读取普通 JSON 条目。取消关注只移除本地图索引；显式重新登记可恢复关注。

实验端用原子改名更新 statusPath，例如 `{"runId":"audio/run-42","phase":"评测","step":42,"updated":1795000000000,"state":"running"}`。节点的“推进”时间取 step 或 phase 的实际变化，进程最近观测时间另列。

| 目的 | MCP 调用 |
| --- | --- |
| 找运行 | map_workloadsPage 分页读取。indexPending=true 表示继续查询可发现下一批索引。map_workloadDetail 返回运行引用。 |
| 查模型和耗时 | map_modelAnalysis({ref,view:"step",attempt:2}) 可按 sample、module 筛选。map_runProfile({ref}) 返回阶段及分页游标。 |
| 录制 | map_recordingControl({action:"start",durationMs:60000}) 返回 ID 和截止时间。list 按页列出录制；stop 提前结束。每十秒一份机器采样，最长十分钟、最多 20 MiB。 |
| 读历史 | map_recordingRead({id,limit:20,fields:["stamp","cpuPercent","memoryAvailable"]}) 返回数据、cursor 和 hasMore。from / to 是包含边界的 Unix 毫秒时间，可按 endpoint 筛选。 |

## 指定路径交付文件

```json
{"source":{"kind":"recording","id":"<录制 ID>"},"format":"csv","target":{"endpoint":"train","path":"/experiments/audio/outputs/42/resources.csv"},"operationId":"audio/run-42/export-1"}
```

以上是 map_artifactExport 参数。resources 支持单机 query，recording 支持时间范围，storage 可用快照 id 和可选基线 before 输出 JSON。map_job 查询进度、结果和错误，map_jobControl 取消。内容分块写入同目录暂存文件，验证 SHA-256 后发布新文件。成功返回 ref、bytes、sha256。已存在的文件保留；原有音频和报告文件可直接读取或传输。

WSL 2 的 wslBudget 区分 Windows .wslconfig 声明、当前可见 CPU 和内存、宿主物理余量和提交量。进程详情入口可看 Linux 的 swap、内存压力及宿主可取得的 vmmemWSL 工作集和私有提交量。多个发行版共享虚拟机预算。
