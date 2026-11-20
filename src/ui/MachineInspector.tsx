import React, { useEffect, useState } from "react";
import { pressureSignals } from "../shared/pressure";
import { useVisibleQuery } from "./visibleQuery";
import type { Pick, MachineMetric } from "./SurfaceCards";
const bytes = (n: any) =>
  n == null
    ? "—"
    : n >= 2 ** 30
      ? (n / 2 ** 30).toFixed(1) + " GiB"
      : n >= 2 ** 20
        ? (n / 2 ** 20).toFixed(1) + " MiB"
        : n >= 1024
          ? (n / 1024).toFixed(1) + " KiB"
          : Math.round(n) + " B";
const gpuProcessMemory = (p: any) =>
  p.gpuMemory > 0
    ? bytes(p.gpuMemory)
    : p.gpuSharedMemory > 0
      ? bytes(p.gpuSharedMemory) + " 共享"
      : bytes(p.gpuMemory);
const percent = (n: any) => (n == null ? "—" : Number(n).toFixed(1) + "%");
const at = (n: any) => (n ? new Date(n).toLocaleTimeString() : "尚未查询");
const number = (n: any, suffix = "") =>
  n == null
    ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }) +
      suffix;
function Meter({
  value,
  max,
  label,
}: {
  value?: number;
  max?: number;
  label: string;
}) {
  return (
    <div
      className="meter"
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuetext={value == null ? "等待采样" : undefined}
      aria-valuemin={0}
      aria-valuemax={max ?? 100}
    >
      <span
        style={{
          width:
            Math.max(0, Math.min(100, (100 * (value ?? 0)) / (max || 100))) +
            "%",
        }}
      />
    </div>
  );
}
function Trend({ values, max }: { values: (number | null)[]; max?: number }) {
  const data = values.filter((v) => v != null) as number[];
  if (data.length < 2) return <div className="trend-empty">等待连续样本</div>;
  const top = max || Math.max(...data, 1);
  return (
    <svg
      className="trend"
      viewBox="0 0 240 48"
      preserveAspectRatio="none"
      role="img"
      aria-label="最近十分钟趋势"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        points={data
          .map(
            (v, i) => `${(i * 240) / (data.length - 1)},${46 - (44 * v) / top}`,
          )
          .join(" ")}
      />
    </svg>
  );
}
function Pressure({
  sample,
  compact = false,
  onProcesses,
}: {
  sample: any;
  compact?: boolean;
  onProcesses?: () => void;
}) {
  const m = sample?.system?.memory,
    p = sample?.system?.pressure,
    warnings = pressureSignals(sample);
  if (!m) return null;
  return (
    <section className="pressure-panel">
      {warnings.length > 0 && (
        <p className="inline-error">{warnings.join(" · ")}</p>
      )}
      <div>
        可用内存 <strong>{bytes(m.available)}</strong>
        {m.commitLimit != null && (
          <>
            {" "}
            · 系统提交量{" "}
            <strong>
              {bytes(m.commitUsed)} / {bytes(m.commitLimit)}
            </strong>
          </>
        )}
        {m.swapTotal != null && (
          <>
            {" "}
            · Swap{" "}
            <strong>
              {bytes(m.swapUsed)} / {bytes(m.swapTotal)}
            </strong>
          </>
        )}
      </div>
      {!compact && (
        <>
          {m.pagefileBytes != null && (
            <div>
              分页文件大小 {bytes(m.pagefileBytes)} ·
              提交量包含物理内存及分页支持。
            </div>
          )}
          {p && (
            <div>
              内存等待 PSI（近 10 秒）{percent(p.memory?.some?.avg10)} ·
              全部阻塞 {percent(p.memory?.full?.avg10)}
              <br />
              换入／换出 {number(p.paging?.swapInPagesPerSecond)} /{" "}
              {number(p.paging?.swapOutPagesPerSecond)} 页/秒 · 主缺页{" "}
              {number(p.paging?.majorFaultsPerSecond)} 次/秒
              <br />
              内核 OOM 终止 {number(p.paging?.oomKills)}
              （本次启动累计）；当前采集器 cgroup OOM{" "}
              {number(p.cgroup?.events?.oom)} / 终止{" "}
              {number(p.cgroup?.events?.oom_kill)}
            </div>
          )}
          {sample.physicalBudget && (
            <div>
              WSL 承载卷 {sample.physicalBudget.mount} 余量{" "}
              {bytes(sample.physicalBudget.available)} ·{" "}
              {at(sample.physicalBudget.stamp)}
            </div>
          )}
          {warnings.length > 0 && onProcesses && (
            <button onClick={onProcesses}>查看内存占用进程</button>
          )}
        </>
      )}
    </section>
  );
}

export function MachineInspector({
  pick,
  machine,
  call,
}: {
  pick: Pick;
  machine: MachineMetric;
  call: (m: string, a?: any) => Promise<any>;
}) {
  const endpoint = machine.endpoint;
  const [tab, setTab] = useState(
    pick.kind === "gpu" ? "gpus" : pick.kind === "disk" ? "io" : "processes",
  );
  const [selected, setSelected] = useState<any>(
    pick.kind === "gpu" ? { kind: "gpu", id: pick.id } : undefined,
  );
  const [data, setData] = useState<any>(),
    [processPage, setProcessPage] = useState<any>(),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState<string>(pick.sort ?? "rss"),
    [offset, setOffset] = useState(0),
    [scroll, setScroll] = useState(0),
    [filter, setFilter] = useState(""),
    [loading, setLoading] = useState(true),
    [failure, setFailure] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setFilter(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  useVisibleQuery(
    () =>
      call("snapshot", {
        endpoint,
        section: selected?.exited ? tab : (selected?.kind ?? tab),
        search: filter,
        sort,
        offset,
        limit: 50,
        pid: selected?.pid,
        identity: selected?.identity,
        gpu: selected?.id,
      }),
    (v) => {
      setData(v);
      setLoading(false);
      setFailure("");
      if (v.section === "processes") setProcessPage(v);
      if (
        v.section === "process" &&
        ["exited", "changed"].includes(v.detailStatus)
      )
        setSelected((s: any) => ({
          ...s,
          exited: true,
          reason: v.detailStatus,
        }));
    },
    (e) => {
      setFailure(String(e));
      setLoading(false);
    },
    [endpoint, tab, filter, sort, offset, selected, call],
    5000,
  );
  const changeTab = (value: string) => {
    setTab(value);
    setSelected(undefined);
    setOffset(0);
    setLoading(true);
  };
  const act = (method: string, args: any) =>
    call(method, args).catch((e) => {
      setFailure(String(e));
    });
  const details = data?.detail,
    summary = data,
    rows = processPage?.processes ?? [],
    start = Math.max(0, Math.floor(scroll / 38) - 4),
    end = Math.min(rows.length, start + 26);
  return (
    <div className="machine-inspector">
      {machine.kind === "wsl" && data?.wslBudget && (
        <details>
          <summary>Windows 预算与 WSL 实测</summary>
          <dl>
            {[
              [
                "配置的内存上限",
                data.wslBudget.config.memory ??
                  (data.wslBudget.config.source === "unavailable"
                    ? "未读取"
                    : "系统默认"),
              ],
              ["配置的 CPU", data.wslBudget.config.processors ?? "系统默认"],
              ["配置的 swap", data.wslBudget.config.swap ?? "系统默认"],
              ["WSL 实测 CPU", data.wslBudget.visibleCpus],
              ["WSL 实测总内存", bytes(data.wslBudget.visibleMemory)],
              ["Linux 可用内存", bytes(data.system?.memory?.available)],
              [
                "swap 已用 / 总量",
                bytes(data.system?.memory?.swapUsed) +
                  " / " +
                  bytes(data.system?.memory?.swapTotal),
              ],
              ["宿主可用内存", bytes(data.wslBudget.hostAvailable)],
              [
                "宿主提交量 / 上限",
                bytes(data.wslBudget.hostCommitUsed) +
                  " / " +
                  bytes(data.wslBudget.hostCommitLimit),
              ],
            ].map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
            {data.wslBudget.hostProcesses?.map((p: any) => (
              <React.Fragment key={p.pid}>
                <dt>vmmemWSL · 工作集 / 私有提交量</dt>
                <dd>
                  {bytes(p.rss)} / {bytes(p.privateBytes)}
                </dd>
              </React.Fragment>
            ))}
          </dl>
          <p>
            配置来自 Windows .wslconfig，运行值由当前 WSL 2
            虚拟机读取。各发行版共享虚拟机预算。
          </p>
        </details>
      )}
      {failure && <p role="alert">{failure}</p>}
      {!selected && (
        <details>
          <summary>资源趋势</summary>
          <div className="summary-strip">
            <div>
              <span>整机 CPU</span>
              <strong>{percent(summary?.system?.cpuPercent)}</strong>
              <Trend
                values={(summary?.history ?? []).map((p: any) => p.cpuPercent)}
                max={100}
              />
            </div>
            <div>
              <span>内存</span>
              <strong>
                {bytes(summary?.system?.memory?.used)}{" "}
                <small>/ {bytes(summary?.system?.memory?.total)}</small>
              </strong>
              <Trend
                values={(summary?.history ?? []).map((p: any) => p.memoryUsed)}
                max={summary?.system?.memory?.total}
              />
            </div>
            <div>
              <span>
                {machine?.kind === "wsl" ? "WSL · 共享宿主资源" : "当前采样"}
              </span>
              <strong className="sample-time">{at(summary?.stamp)}</strong>
              <span
                className={summary?.status === "offline" ? "inline-error" : ""}
              >
                {summary?.status === "offline"
                  ? summary.error
                  : "详细视图 · 5 秒刷新"}
              </span>
            </div>
          </div>
          <Pressure
            sample={summary}
            onProcesses={() => {
              setTab("processes");
              setSort("rss");
            }}
          />
        </details>
      )}
      {!selected && (
        <nav className="resource-tabs" aria-label="资源类别">
          {[
            ["processes", "进程"],
            ["gpus", "GPU"],
            ["io", "磁盘 / 网络"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              aria-pressed={tab === id}
              onClick={() => changeTab(id)}
            >
              {label}
            </button>
          ))}
          {loading && <span role="status">正在读取…</span>}
        </nav>
      )}
      <div className={selected ? "detail-layout" : ""}>
        {!selected && (
          <section className="resource-content">
            {tab === "processes" && (
              <>
                <div className="process-controls">
                  <input
                    aria-label="筛选进程名称、用户或 PID"
                    placeholder="搜索进程、用户或 PID"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <select
                    aria-label="进程排序"
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="rss">内存从高到低</option>
                    <option value="cpuPercent">CPU 从高到低</option>
                    <option value="gpuMemory">GPU 显存从高到低</option>
                    <option value="name">名称</option>
                  </select>
                  <span>{processPage?.total ?? "—"} 个进程</span>
                </div>
                <div
                  className="process-table"
                  role="table"
                  aria-label="进程资源"
                >
                  <div className="process-row table-head" role="row">
                    <span>进程 / 用户</span>
                    <span>PID</span>
                    <span>CPU · 单核</span>
                    <span>工作集 / RSS</span>
                    <span>GPU 显存</span>
                  </div>
                  <div
                    className="process-scroll"
                    onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
                  >
                    <div style={{ height: start * 38 }} />
                    {rows.slice(start, end).map((p: any) => (
                      <button
                        role="row"
                        key={p.identity ?? p.pid}
                        className="process-row"
                        onClick={() => {
                          setSelected({ ...p, kind: "process" });
                          setLoading(true);
                        }}
                      >
                        <span className="process-name">
                          <strong>{p.name}</strong>
                          <span>{p.user ?? "权限受限"}</span>
                        </span>
                        <span>{p.pid}</span>
                        <span>{percent(p.cpuPercent)}</span>
                        <span>{bytes(p.rss)}</span>
                        <span>{gpuProcessMemory(p)}</span>
                      </button>
                    ))}
                    <div
                      style={{ height: Math.max(0, rows.length - end) * 38 }}
                    />
                  </div>
                </div>
                <div className="pagination">
                  <button
                    disabled={!offset}
                    onClick={() => {
                      setOffset(Math.max(0, offset - 50));
                      setSelected(undefined);
                      setScroll(0);
                    }}
                  >
                    上一页
                  </button>
                  <span>
                    {offset + 1}–{offset + rows.length} /{" "}
                    {processPage?.total ?? "—"}
                  </span>
                  <button
                    disabled={offset + 50 >= (processPage?.total ?? 0)}
                    onClick={() => {
                      setOffset(offset + 50);
                      setSelected(undefined);
                      setScroll(0);
                    }}
                  >
                    下一页
                  </button>
                </div>
              </>
            )}
            {tab === "gpus" && (
              <div className="gpu-table">
                <div className="gpu-row table-head">
                  <span>设备</span>
                  <span>利用率</span>
                  <span>显存</span>
                  <span>温度</span>
                  <span>功耗</span>
                </div>
                {(data?.gpus ?? summary?.gpus ?? []).map((g: any) => (
                  <button
                    className="gpu-row"
                    key={g.id}
                    onClick={() => {
                      setSelected({ ...g, kind: "gpu" });
                      setLoading(true);
                    }}
                  >
                    <span>
                      <strong>
                        {g.index != null ? `GPU ${g.index} · ` : ""}
                        {g.name
                          .replace(/^NVIDIA /, "")
                          .replace(/ Blackwell$/, "")}
                      </strong>
                      <span className="gpu-id">{g.bus ?? g.id}</span>
                    </span>
                    <span>{percent(g.utilization)}</span>
                    <span>
                      {bytes(g.memoryUsed ?? g.dedicatedUsed)} /{" "}
                      {bytes(g.memoryTotal)}
                    </span>
                    <span>{number(g.temperature, " °C")}</span>
                    <span>{number(g.powerWatts, " W")}</span>
                  </button>
                ))}
                {(data?.errors ?? []).map((e: string) => (
                  <p key={e} className="inline-error">
                    {e}
                  </p>
                ))}
              </div>
            )}
            {tab === "io" && (
              <div className="io-sections">
                <h2>磁盘容量</h2>
                {(data?.io?.volumes ?? []).map((v: any) => (
                  <div className="volume-row" key={v.path}>
                    <button
                      onClick={() =>
                        void act("locate", {
                          ref: { endpoint: machine.endpoint, path: v.path },
                        })
                      }
                    >
                      {v.path}
                    </button>
                    <Meter
                      value={v.total - v.available}
                      max={v.total}
                      label={v.path + " 已用空间"}
                    />
                    <span>
                      可用 {bytes(v.available)} / {bytes(v.total)}
                    </span>
                  </div>
                ))}
                <h2>磁盘吞吐</h2>
                {(data?.io?.disks ?? []).map((v: any) => (
                  <div className="io-row" key={v.name}>
                    <strong>{v.name}</strong>
                    <span>读取 {bytes(v.readBytesPerSecond)}/s</span>
                    <span>写入 {bytes(v.writeBytesPerSecond)}/s</span>
                  </div>
                ))}
                <h2>网络吞吐</h2>
                {(data?.io?.network ?? []).map((v: any) => (
                  <div className="io-row" key={v.name}>
                    <strong>{v.name}</strong>
                    <span>接收 {bytes(v.receiveBytesPerSecond)}/s</span>
                    <span>发送 {bytes(v.sendBytesPerSecond)}/s</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        {selected && (
          <aside className="device-inspection">
            <div className="drawer-title">
              <h2>{selected.kind === "gpu" ? "GPU 详情" : "进程详情"}</h2>
              {pick.kind !== "gpu" && (
                <button
                  aria-label="返回列表"
                  onClick={() => setSelected(undefined)}
                >
                  返回列表
                </button>
              )}
            </div>
            <h3>{details?.name ?? selected.name}</h3>
            {!details ? (
              <p>
                {loading
                  ? "正在读取…"
                  : selected?.reason === "changed"
                    ? "进程身份已变化，请在列表重新选择"
                    : "对象已退出，列表继续更新"}
              </p>
            ) : (
              <>
                {selected.kind === "process" ? (
                  <dl>
                    {[
                      ["PID", details.pid],
                      ["用户", details.user],
                      ["CPU · 单核", percent(details.cpuPercent)],
                      ["工作集 / RSS", bytes(details.rss)],
                      ["PSS", bytes(details.pss)],
                      ["私有提交量", bytes(details.privateBytes)],
                      ["内存来源", details.memorySource ?? "进程接口"],
                      ...(details.memoryStamp
                        ? [
                            [
                              "内存采样时间",
                              new Date(
                                details.memoryStamp,
                              ).toLocaleTimeString(),
                            ],
                          ]
                        : []),
                      ["线程", details.threads],
                      ["句柄 / 文件描述符", details.handles],
                      ["GPU 显存", bytes(details.gpuMemory)],
                      ["共享 GPU 内存", bytes(details.gpuSharedMemory)],
                      ["可执行文件", details.executable],
                    ]
                      .filter(([, v]) => v != null && v !== "—")
                      .map(([k, v]) => (
                        <React.Fragment key={k}>
                          <dt>{k}</dt>
                          <dd>
                            {k === "可执行文件" ? (
                              <button
                                className="path-link"
                                onClick={() =>
                                  void act("locate", {
                                    ref: {
                                      endpoint: machine.endpoint,
                                      path: details.executable,
                                    },
                                    file: true,
                                  })
                                }
                              >
                                {v}
                              </button>
                            ) : (
                              v
                            )}
                          </dd>
                        </React.Fragment>
                      ))}
                  </dl>
                ) : (
                  <dl>
                    {[
                      ["设备标识", details.id],
                      ["驱动", details.driver],
                      ["计算能力", details.computeCapability],
                      ["驱动 CUDA 兼容", details.driverCudaCompatibility],
                      [
                        "显存控制器利用率",
                        details.memoryUtilization == null
                          ? null
                          : percent(details.memoryUtilization),
                      ],
                      [
                        "最忙引擎利用率",
                        details.engineUtilization == null
                          ? null
                          : percent(details.engineUtilization),
                      ],
                      ["利用率", percent(details.utilization)],
                      [
                        "显存",
                        bytes(details.memoryUsed ?? details.dedicatedUsed) +
                          " / " +
                          bytes(details.memoryTotal),
                      ],
                      ["共享内存使用", bytes(details.sharedUsed)],
                      ["共享内存上限", bytes(details.sharedMemoryTotal)],
                      ["温度", number(details.temperature, " °C")],
                      ["功耗", number(details.powerWatts, " W")],
                      ["功耗上限", number(details.powerLimitWatts, " W")],
                      ["SM 时钟", number(details.smClockMHz, " MHz")],
                      ["显存时钟", number(details.memoryClockMHz, " MHz")],
                      [
                        "PCIe",
                        details.pcieGeneration
                          ? `Gen ${details.pcieGeneration} × ${details.pcieWidth}`
                          : null,
                      ],
                      ["数据来源", details.source],
                    ]
                      .filter(([, v]) => v != null && v !== "—")
                      .map(([k, v]) => (
                        <React.Fragment key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </React.Fragment>
                      ))}
                  </dl>
                )}
                {details.access && (
                  <p className="resource-note">当前账号可读取部分进程信息</p>
                )}
                {details.role && (
                  <section>
                    <h3>{details.role}</h3>
                    <p className="resource-note">来源：已识别启动标记</p>
                  </section>
                )}
                {details.project && (
                  <section>
                    <h3>已登记项目</h3>
                    <button
                      className="path-link"
                      onClick={() =>
                        void act("locate", { ref: details.project })
                      }
                    >
                      {details.project.path}
                    </button>
                    <p className="resource-note">
                      来源：Wayfarer 项目登记与工作目录
                    </p>
                  </section>
                )}
                {details.cwd && (
                  <section>
                    <h3>工作目录</h3>
                    <button
                      className="path-link"
                      onClick={() =>
                        void act("locate", {
                          ref: {
                            endpoint: machine.endpoint,
                            path: details.cwd,
                          },
                        })
                      }
                    >
                      {details.cwd}
                    </button>
                    <p className="resource-note">来源：操作系统工作目录</p>
                  </section>
                )}
                {details.container && (
                  <section>
                    <h3>容器</h3>
                    <code>{details.container.id}</code>
                    <p className="resource-note">
                      来源：{details.container.source}
                    </p>
                  </section>
                )}
                {selected.kind === "gpu" && (
                  <section>
                    <h3>GPU 利用率</h3>
                    <Trend
                      values={(data?.history ?? []).map(
                        (p: any) =>
                          p.gpus?.find((g: any) => g.id === selected.id)
                            ?.utilization ?? null,
                      )}
                      max={100}
                    />
                    <h3>关联进程</h3>
                    {(data?.processes ?? []).map((p: any) => (
                      <button
                        className="gpu-process"
                        key={p.identity ?? p.pid}
                        onClick={() => {
                          setTab("processes");
                          setSelected({ ...p, kind: "process" });
                        }}
                      >
                        <span>
                          {p.name} · {p.pid}
                        </span>
                        <strong>{gpuProcessMemory(p)}</strong>
                      </button>
                    ))}
                    <p className="resource-note">
                      驱动可见的计算进程；受权限和驱动模式影响。
                    </p>
                  </section>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
