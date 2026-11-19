# 多机巡检与性能对照

从 VS Code 侧边栏打开「机器资源」。在「多机对照」里勾选机器，查看 GPU 利用率和显存、磁盘或挂载余量及采样时间。离线机器显示最后一次可用采样。同名设备各按机器展示。NFS 来源相同的挂载列为候选，请确认同一网络与导出后按一份显示。容量来自最近在线成员，成员离线时保留采样时间。

## 通信与文件

「链路诊断」使用已登记 SSH 机器的活动私网 IPv4。检查连通默认对照 TCP 22 和路由所选接口。测速另行发起，双向默认各 64 MiB，从内存发送到内存，以接收确认计时，测速期间只执行一对。服务器测速使用临时端口和短时进程。如果网段放行 SSH 而拦截临时端口，路由检查和测速会各自显示结果。本机 RDMA 列表来自 Linux 设备信息，云端配置由云平台查询。

「传输与后台任务 → 性能详情」显示实际经 Wayfarer 执行的读取、写入和校验阶段。读取与写入包含通道等待。跨端读写可能重叠，最近 96 个阶段片段展示在时间线上，累计值覆盖各次执行段。执行总耗时包含各次恢复后的执行段，主动暂停和重新排队期间单独排除。

## 运行记录

外部脚本启动作业。任务完成后将记录保存在项目的产物目录，在「运行报告」选文件或用 MCP 登记引用。原始日志与运行记录沿用端点权限。每个节点的阶段偏移从该节点启动计算，图中节点间的相对起点各自标注。需要做跨机因果分析时请使用原始日志中的同步标记。

版本 1 为 1 MiB 内的 JSON。每次运行最多 64 个节点、4000 个阶段。以下是两节点的最小示例。

```json
{
  "version": 1,
  "runId": "experiment-42",
  "project": "activation-extraction",
  "label": "NFS 直读",
  "commit": "pinned-source-identity",
  "dataset": "frozen-input-identity",
  "samples": 4,
  "durationMs": 900,
  "nodes": [
    {
      "endpoint": "train",
      "label": "训练机 1",
      "startedAt": 1794960000000,
      "stages": [
        {"kind": "wait", "label": "读取样本", "offsetMs": 0, "durationMs": 160, "bytes": 4096}
      ],
      "log": {"endpoint": "train", "path": "/data/project/run.log"}
    },
    {
      "endpoint": "train2",
      "label": "训练机 2",
      "stages": [
        {"kind": "compute", "offsetMs": 120, "durationMs": 500},
        {"kind": "communication", "offsetMs": 210, "durationMs": 300}
      ]
    }
  ]
}
```

阶段类型有 `wait`、`compute`、`communication`、`write`、`other`。同节点同类重叠时间只计一次，多节点合计按节点累加。运行总耗时使用运行方提供的墙钟值。缺少的阶段显示「未采集」。

## MCP

- `map_systemResources({endpoints:[...]})` 返回最多八台机器的精简对照。先拿到共享挂载候选的 `key`，核对网络与导出后可传 `confirmedShares`。旧单机参数继续使用。
- `map_linkInterfaces({endpoint})` 选择实际私网地址。随后提交 `map_linkProbe({source:{endpoint,address},target:{endpoint,address},measure:true})`，通过 `map_job` 或任务窗口查看和取消。
- `map_runProfile({ref,remember:true})` 登记运行记录，`offset`、`limit` 读取阶段分页。省略 `ref` 返回当前地图最近使用的记录引用。
- 侧边栏「诊断与接入 → 绑定此窗口」显示地图 ID，可写入 Codex 或 dsh 配置。运行中的 MCP 会话可以显式 `map_bind`。不同地图之间的绑定由用户选择。
