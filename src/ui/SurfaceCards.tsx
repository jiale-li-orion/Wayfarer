import React from "react";
export type MachineMetric = {
  endpoint: string;
  name: string;
  kind?: string;
  status?: string;
  stamp?: number;
  cpuPercent?: number;
  memoryAvailable?: number;
  wslBudget?: {
    config: {
      source: string;
      invalid?: string[];
      memory?: string;
      processors?: number;
    };
    visibleCpus?: number;
    visibleMemory?: number;
  };
  gpus: {
    id: string;
    utilization?: number;
    memoryTotal?: number;
    memoryUsed?: number;
  }[];
  volumes: { path: string; available?: number }[];
};
export const capacity = (n?: number) =>
  n == null
    ? "—"
    : n < 1048576
      ? (n / 1024).toFixed(0) + " KiB"
      : n < 1073741824
        ? (n / 1048576).toFixed(0) + " MiB"
        : n >= 2 ** 40
          ? (n / 2 ** 40).toFixed(1) + " TiB"
          : (n / 2 ** 30).toFixed(1) + " GiB";
export const percent = (v?: number) => (v == null ? "—" : Math.round(v) + "%");
export type Pick = {
  kind:
    | "machine"
    | "processes"
    | "gpu"
    | "disk"
    | "run"
    | "pair"
    | "runs"
    | "groups";
  endpoint?: string;
  id?: string;
  other?: string;
  path?: string;
  sort?: "cpuPercent" | "rss";
};
export function MachineTile({
  m,
  pick,
  pairing,
  togglePair,
  mount,
}: {
  m: MachineMetric;
  pick: (p: Pick) => void;
  pairing: boolean;
  togglePair: () => void;
  mount?: string;
}) {
  const volume =
    m.volumes.find((v) => v.path === mount) ??
    m.volumes.find((v) => v.path === "/") ??
    m.volumes[0];
  const open = (kind: Pick["kind"], extra: Partial<Pick> = {}) =>
    pick({ kind, endpoint: m.endpoint, ...extra });
  return (
    <article
      className={"wf-machine nodrag nopan " + (pairing ? "paired" : "")}
      aria-label={m.name}
      data-machine={m.endpoint}
    >
      <header>
        <button className="machine-name" onClick={() => open("machine")}>
          {m.name.replace(/ · SSH$/, "")}
        </button>
        <span
          className={"availability " + (m.status ?? "waiting")}
          title={m.stamp ? new Date(m.stamp).toLocaleTimeString() : undefined}
        >
          {m.status === "online"
            ? "在线"
            : m.status === "offline"
              ? "离线" +
                (m.stamp ? " · " + new Date(m.stamp).toLocaleTimeString() : "")
              : "读取中"}
        </span>
        {m.kind === "ssh" && (
          <button
            className="pair-action"
            title="选择机器配对"
            aria-label={"选择机器配对 " + m.name}
            aria-pressed={pairing}
            onClick={togglePair}
          >
            ⇄
          </button>
        )}
      </header>
      <div className="machine-metrics">
        <button onClick={() => open("processes", { sort: "cpuPercent" })}>
          CPU <b>{percent(m.cpuPercent)}</b>
          {m.kind === "wsl" && m.wslBudget?.visibleCpus != null && (
            <span> / {m.wslBudget.visibleCpus} 核</span>
          )}
        </button>
        <button onClick={() => open("processes", { sort: "rss" })}>
          {m.kind === "wsl" && m.wslBudget ? "内存上限" : "可用内存"}{" "}
          <b>
            {m.kind === "wsl" && m.wslBudget
              ? (m.wslBudget?.config.memory?.replace(
                  /(\d)([KMGT]B)$/,
                  "$1 $2",
                ) ??
                (!m.wslBudget || m.wslBudget.config.source === "unavailable"
                  ? "未读取"
                  : m.wslBudget.config.invalid?.includes("memory")
                    ? "配置待核对"
                    : "系统默认 · 实测 " + capacity(m.wslBudget.visibleMemory)))
              : capacity(m.memoryAvailable)}
          </b>
        </button>
      </div>
      {m.gpus.length > 0 && (
        <div className="device-strip">
          <div className="device-caption">
            GPU <span>利用率 · 可用显存</span>
          </div>
          <div className="device-grid">
            {m.gpus.map((g, i) => (
              <button
                key={g.id}
                onClick={() => open("gpu", { id: g.id })}
                aria-label={
                  "GPU " +
                  i +
                  "，利用率 " +
                  percent(g.utilization) +
                  "，可用显存 " +
                  capacity(
                    g.memoryTotal != null && g.memoryUsed != null
                      ? Math.max(0, g.memoryTotal - g.memoryUsed)
                      : undefined,
                  )
                }
              >
                <span>
                  <b>{i}</b>
                  {percent(g.utilization)}
                </span>
                <strong>
                  {capacity(
                    g.memoryTotal != null && g.memoryUsed != null
                      ? Math.max(0, g.memoryTotal - g.memoryUsed)
                      : undefined,
                  )}
                </strong>
                <i
                  style={{
                    width: Math.min(100, Math.max(0, g.utilization ?? 0)) + "%",
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        className="mount"
        title={volume?.path}
        onClick={() => open("disk", { path: volume?.path })}
      >
        <span>{volume?.path ?? "磁盘"}</span>
        <span>{capacity(volume?.available)} 可用</span>
      </button>
    </article>
  );
}
export function RunTile({
  name,
  phase,
  step,
  updated,
  attention,
  open,
  details,
}: {
  name: string;
  phase?: string;
  step?: number;
  updated?: number;
  attention: boolean;
  open: () => void;
  details: () => void;
}) {
  return (
    <div
      className={
        "run-tile nodrag nopan" + (attention ? " needs-attention" : "")
      }
    >
      <button onClick={open}>
        <strong>{name}</strong>
        <small>
          {phase} {step != null ? "· step " + step : ""}{" "}
          {updated != null && (
            <span title={new Date(updated).toLocaleString()}>
              ·{" "}
              {Math.max(0, Math.floor((Date.now() - updated) / 60000)) ||
                "刚刚"}
              {Date.now() - updated >= 60000 ? " 分钟前" : ""}推进
            </span>
          )}
        </small>
      </button>
      <button
        title="运行详情"
        aria-label={name + " 运行详情"}
        onClick={details}
      >
        ⋯
      </button>
    </div>
  );
}
