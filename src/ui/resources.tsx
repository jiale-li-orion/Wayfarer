import { pressureSignals } from "../shared/pressure";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./resources.css";
import { FleetPanel, JobPerformance, RunsPanel } from "./PerformanceViews";
import { ModelAnalysis } from "./ModelAnalysis";
import {WorkloadPanel} from "./WorkloadPanel";
import type {WorkloadFile} from "../core/workloads";
type ResourceTab = "workloads" | "model" | "machine" | "comparison" | "runs" | "job";
declare const acquireVsCodeApi: () => {
  postMessage(v: any): void;
  setState(v: any): void;
  getState(): any;
};
const api = acquireVsCodeApi();
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
const listeners = new Set<(v: any) => void>();
function rpc(method: string, args: any = {}) {
  const id = ++seq;
  api.postMessage({ id, method, args });
  return new Promise<any>((resolve, reject) =>
    pending.set(id, { resolve, reject }),
  );
}
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p?.reject(Error(m.error)) : p?.resolve(m.result);
  } else listeners.forEach((f) => f(m));
});
window.addEventListener("pagehide", () => {
  pending.forEach((p) => p.reject(Error("View hidden")));
  pending.clear();
  listeners.clear();
});
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
function App() {
  const saved = api.getState() ?? {};
  const [view, setView] = useState<ResourceTab>(saved.view === "comparison" ? "machine" : saved.view ?? "machine");
  const [jobId, setJobId] = useState<string | undefined>(saved.jobId);
  const [runId,setRunId]=useState<string|undefined>(saved.runId);
  const [file,setFile]=useState<WorkloadFile|undefined>(saved.file);
  const [sweep,setSweep]=useState(0);
  const openView = (request?: { view?: ResourceTab; jobId?: string;runId?:string }) => {
    if (request?.view) {
      if(request.view==="machine" || request.view==="comparison")selectMachine();
      setView(request.view==="comparison"?"machine":request.view);
      setRunId(request.runId);setFile(undefined);
      setJobId(request.jobId);
    }
  };
  const [machines, setMachines] = useState<any[]>([]),
    [snapshots, setSnapshots] = useState<Record<string, any>>({});
  const [endpoint, setEndpoint] = useState<string | undefined>(saved.endpoint),
    [tab, setTab] = useState(saved.tab ?? "processes");
  const [search, setSearch] = useState(saved.search ?? ""),
    [filter, setFilter] = useState(saved.search ?? ""),
    [sort, setSort] = useState(saved.sort ?? "rss"),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<any>(),
    [data, setData] = useState<any>(),
    [processPage, setProcessPage] = useState<any>(),
    [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false),
    [failure, setFailure] = useState("");
  const query = useMemo(
    () =>
      endpoint
        ? {
            selectedOnly:true,endpoint,
            section: selected?.exited ? tab : (selected?.kind ?? tab),
            search: filter,
            sort,
            offset,
            limit: 50,
            ...(selected?.kind === "process" && !selected?.exited
              ? { pid: selected.pid, identity: selected.identity }
              : {}),
            ...(selected?.kind === "gpu" ? { gpu: selected.id } : {}),
          }
        : {},
    [endpoint, tab, selected, filter, sort, offset],
  );
  const latest = useRef<any>(query);
  latest.current = query;
  const mounted = useRef(true);
  const accept = (v: any) => {
    setSnapshots((old) => ({ ...old, [v.endpoint]: v }));
    const q = latest.current;
    if (
      v.endpoint === q.endpoint &&
      v.section === q.section &&
      v.query?.pid === q.pid &&
      v.query?.gpu === q.gpu &&
      v.query?.search === q.search &&
      v.query?.offset === q.offset &&
      v.query?.sort === q.sort
    ) {
      setData(v);
      if (
        v.section === "process" &&
        ["exited", "changed"].includes(v.detailStatus)
      )
        setSelected((old: any) =>
          old ? { ...old, exited: true, reason: v.detailStatus } : old,
        );
      if (v.section === "processes") setProcessPage(v);
      setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    const listen = (m: any) => {
      if (m.type === "sample") accept(m.value);
      if (m.type === "open") openView(m.request);
      if (m.type === "recordingStopped") setRecording(false);
      if (m.type === "recordingError") {
        setFailure(m.error);
        setRecording(false);
      }
    };
    listeners.add(listen);
    const visibility = () =>
      void rpc("visibility", { visible: !document.hidden }).catch(() => {});
    document.addEventListener("visibilitychange", visibility);
    void rpc("bootstrap", { visible: !document.hidden })
      .then((s) => {
        if (!mounted.current) return;
        setMachines(s.machines);
        openView(s.selection);
        for (const v of s.snapshots) accept(v);
        setRecording(!!s.recording);
      })
      .catch((e) => setFailure(String(e)));
    return () => {
      mounted.current = false;
      listeners.delete(listen);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!machines.length) return;
    setLoading(!!endpoint);
    setFailure("");
    void rpc("watch", view === "machine" && endpoint ? query : null).catch((e) => setFailure(String(e)));
    api.setState({ endpoint, tab, search: filter, sort, view, jobId,runId,file });
  }, [query, machines.length, view, jobId,runId,file]);
  useEffect(() => {
    const t = setTimeout(() => {
      setFilter(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (!selected) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(undefined);
    };
    window.addEventListener("keydown", escape);
    document.querySelector<HTMLButtonElement>(".drawer-title button")?.focus();
    return () => window.removeEventListener("keydown", escape);
  }, [selected]);
  const machine = machines.find((m) => m.endpoint === endpoint),
    summary = endpoint ? snapshots[endpoint] : undefined;
  const selectMachine = (id?: string) => {
    setEndpoint(id);
    setSelected(undefined);
    setData(undefined);
    setProcessPage(undefined);
    setOffset(0);
  };
  const changeTab = (value: string) => {
    setTab(value);
    setSelected(undefined);
    setData(undefined);
    setProcessPage(undefined);
    setOffset(0);
  };
  const act = (method: string, args?: any) =>
    rpc(method, args).catch((e) => {
      setFailure(String(e));
      return undefined;
    });
  const details = data?.detail;
  const rows =
    tab === "processes"
      ? (processPage?.processes ?? [])
      : (data?.processes ?? []);
  const [scroll, setScroll] = useState(0);
  const start = Math.max(0, Math.floor(scroll / 38) - 4),
    end = Math.min(rows.length, start + 26);
  const refresh = () => {
    setLoading(true);
    void act("snapshot", query).then((v) => {
      if (v && mounted.current) {
        if (v.machines) {
          setMachines(v.machines);
          for (const s of v.snapshots) accept(s);
          void act("watch", query);
        } else accept(v);
      }
    });
  };
  const navigation = (
    <nav className="performance-nav" aria-label="机器资源">
      <button aria-pressed={view==="machine"} onClick={()=>{setView("machine");selectMachine();}}>机器</button>
      <button aria-pressed={view==="workloads"} onClick={()=>{setView("workloads");if(view==="workloads")setRunId(undefined);}}>作业</button>
      {(view==="model"||view==="runs"||view==="job") && runId&&<button onClick={()=>setView("workloads")}>返回作业详情</button>}
      <details className="export-menu"><summary>更多</summary><div>
<button onClick={() => void act("export", { format: "json" })}>
                快照 JSON
              </button>
              <button onClick={() => void act("export", { format: "csv" })}>
                快照 CSV
              </button>
              <button onClick={() => void act("export", { recording: true })}>
                导出记录…
              </button>
        <button onClick={async()=>{const picked=await act("pickModelRun");if(picked){const id=await act("registerPickedRecord",{ref:picked.ref,kind:"model",runId:picked.run.runId});if(id){setRunId(id);setView("workloads");}}}}>关注已有模型运行</button>
        <button onClick={()=>void act("fileTransfers")}>文件传输</button>
        <button onClick={()=>{setFile(undefined);setView("runs");}}>打开历史耗时记录</button>
        <button onClick={()=>{setFile(undefined);setView("model");}}>打开其他模型记录</button>
      </div></details>
    </nav>
  );
  if (view !== "machine")
    return <main className="resources-root">
      {navigation}
      {view==="workloads" && <WorkloadPanel machines={machines} call={rpc} runId={runId} select={setRunId} onTransfer={id=>{setJobId(id);setView("job");}}
        onFile={f=>{if(f.kind==="model"||f.kind==="profile"){setFile(f);setView(f.kind==="model"?"model":"runs");}else void act("openWorkloadFile",{ref:f});}}/>}
      {view === "model" && <ModelAnalysis key={file?.path} call={rpc} initialRef={file}/>}
      {view === "runs" && <RunsPanel key={file?.path} call={rpc} initialRef={file}/>}
      {view === "job" && jobId && <JobPerformance id={jobId} call={rpc} />}
    </main>;
  return (
    <main className="resources-root">
      {navigation}
      <header className="resource-toolbar">
        <div className="breadcrumbs">
          {machine && <button onClick={() => selectMachine()}>所有机器</button>}
          {machine && (
            <>
              <span aria-hidden="true">/</span>
              <strong>{machine.name}</strong>
            </>
          )}
        </div>
        <div className="toolbar-actions">
          <button onClick={()=>endpoint?refresh():setSweep(n=>n+1)}>刷新</button>
          <button
            className={recording ? "recording" : ""}
            onClick={() =>
              void act("record", { start: !recording }).then((v) => {
                if (v) {
                  setRecording(!recording);
                }
              })
            }
          >
            {recording ? "停止记录" : "开始记录"}
          </button>

        </div>
      </header>
      {failure && (
        <div className="resource-error" role="alert">
          {failure}
          <button onClick={() => setFailure("")}>关闭</button>
        </div>
      )}
      {recording && (
        <div className="record-banner">
          <span className="live-dot" />
          正在记录资源 · 每 10 秒 · 十分钟或 20 MiB 自动结束。
        </div>
      )}
      {!endpoint ? (
        machines.length ? <FleetPanel machines={machines} call={rpc} onMachine={selectMachine} refreshToken={sweep}/> : null
      ) : (
        <>
          <div className="machine-switch">
            {machines.map((m) => (
              <button
                key={m.id}
                className={endpoint === m.endpoint ? "selected" : ""}
                onClick={() => selectMachine(m.endpoint)}
              >
                {m.name}
              </button>
            ))}
          </div>
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
          <div className={selected ? "detail-layout" : ""}>
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
            {selected && (
              <aside className="resource-drawer">
                <div className="drawer-title">
                  <h2>{selected.kind === "gpu" ? "GPU 详情" : "进程详情"}</h2>
                  <button
                    aria-label="关闭详情"
                    onClick={() => setSelected(undefined)}
                  >
                    关闭
                  </button>
                </div>
                <h3>{details?.name ?? selected.name}</h3>
                {details && selected.kind==="process" && selected.identity && <button onClick={async()=>{
                  const w=await act("observeProcess",{endpoint,pid:selected.pid,identity:selected.identity,name:selected.name});
                  if(w){setRunId(w.runId);setView("workloads");}
                }}>加入作业</button>}
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
                      <p className="resource-note">
                        当前账号可读取部分进程信息
                      </p>
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
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
