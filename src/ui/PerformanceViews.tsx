import React, { useEffect, useState } from "react";
import type { Ref } from "../shared/types";
import type { TransferTimingRecord } from "../core/transferTiming";

type Call = (method: string, args?: any) => Promise<any>;
type Machine = { id: string; name: string; endpoint: string; kind: string };
type Profile = { ref: Ref; label: string; project: string; runId: string };
type Interface = { device: string; address: string; prefix: number };
type TimelineStage = {
  kind: string;
  offsetMs: number;
  durationMs: number;
  endpoint?: string;
  label?: string;
  bytes?: number;
};

const amount = (n?: number) =>
  n == null
    ? "未采集"
    : n >= 2 ** 40
      ? (n / 2 ** 40).toFixed(1) + " TiB"
      : n >= 2 ** 30
        ? (n / 2 ** 30).toFixed(1) + " GiB"
        : n >= 2 ** 20
          ? (n / 2 ** 20).toFixed(1) + " MiB"
          : Math.round(n) + " B";
const elapsed = (ms?: number) =>
  ms == null
    ? "未采集"
    : ms < 1000
      ? ms.toFixed(1) + " ms"
      : (ms / 1000).toFixed(2) + " 秒";
const stamp = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString() : "尚无采样";
const labels: Record<string, string> = {
  wait: "等待数据",
  compute: "GPU 计算",
  communication: "跨机通信",
  write: "写入",
  verify: "校验",
  read: "读取",
  other: "其他",
};

function Failure({ message }: { message: string }) {
  return message ? (
    <p className="resource-error" role="alert">
      {message}
    </p>
  ) : null;
}

export function FleetPanel({
  machines,
  call,
}: {
  machines: Machine[];
  call: Call;
}) {
  const [chosen, setChosen] = useState<string[]>(() =>
    (machines.some((m) => m.kind === "ssh")
      ? machines.filter((m) => m.kind === "ssh")
      : machines
    )
      .slice(0, 8)
      .map((m) => m.endpoint),
  );
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [sample, setSample] = useState<any>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void call("watchComparison", { endpoints: chosen }).catch((error) =>
      setError(String(error)),
    );
    return () => {
      void call("watchComparison", { endpoints: [] }).catch(() => {});
    };
  }, [chosen, call]);
  useEffect(() => {
    let active = true;
    let sampling = false;
    if (!chosen.length) {
      setSample(undefined);
      return;
    }
    const load = async () => {
      if (!active || sampling || document.hidden) return;
      sampling = true;
      try {
        const value = await call("compare", {
          endpoints: chosen,
          confirmedShares: confirmed,
        });
        if (active) {
          setSample(value);
          setError("");
        }
      } catch (error) {
        if (active) setError(String(error));
      } finally {
        sampling = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [chosen, confirmed, refresh, call]);
  const included = new Set(
    sample?.shares
      ?.filter((s: any) => s.confirmed)
      .flatMap((s: any) =>
        s.mounts.map((m: any) => JSON.stringify([m.endpoint, m.volume.path])),
      ) ?? [],
  );
  return (
    <div className="performance-page">
      <section className="performance-card fleet-options">
        <div className="performance-head">
          <h1>多机对照</h1>
          <button onClick={() => setRefresh((n) => n + 1)}>刷新</button>
        </div>
        <fieldset className="machine-options">
          <legend>选择机器</legend>
          {machines.map((m) => (
            <label key={m.endpoint}>
              <input
                type="checkbox"
                checked={chosen.includes(m.endpoint)}
                disabled={chosen.length >= 8 && !chosen.includes(m.endpoint)}
                onChange={() =>
                  setChosen((prev) =>
                    prev.includes(m.endpoint)
                      ? prev.filter((v) => v !== m.endpoint)
                      : [...prev, m.endpoint],
                  )
                }
              />
              {m.name}
            </label>
          ))}
        </fieldset>
        <Failure message={error} />
      </section>
      {chosen.length > 0 && !sample && !error && (
        <p role="status">读取机器状态…</p>
      )}
      <div className="fleet-grid">
        {(sample?.machines ?? [])
          .filter((m: any) => chosen.includes(m.endpoint))
          .map((m: any) => (
            <section className="performance-card" key={m.endpoint}>
              <div className="performance-head">
                <h2>{m.name}</h2>
                <span
                  className={m.status === "offline" ? "performance-muted" : ""}
                >
                  {m.status === "offline" ? "离线" : "在线"} · {stamp(m.stamp)}
                </span>
              </div>
              {m.error && <p className="performance-muted">{m.error}</p>}
              <h3>GPU · {m.gpus.length} 张</h3>
              <div className="fleet-gpus">
                {m.gpus.map((g: any, index: number) => (
                  <div className="fleet-gpu" key={g.id}>
                    <span>GPU {index}</span>
                    <strong>
                      {g.utilization == null
                        ? "利用率未采集"
                        : g.utilization + "%"}
                    </strong>
                    <span>
                      {amount(g.memoryUsed)} / {amount(g.memoryTotal)}
                    </span>
                    <progress
                      max={g.memoryTotal || 1}
                      value={g.memoryUsed}
                      aria-label={`GPU ${index} 显存`}
                    />
                  </div>
                ))}
              </div>
              <h3>磁盘与挂载</h3>
              {m.volumes
                .filter(
                  (v: any) =>
                    !included.has(JSON.stringify([m.endpoint, v.path])),
                )
                .map((v: any) => (
                  <div className="fleet-volume" key={v.path}>
                    <button
                      onClick={() =>
                        void call("locate", {
                          ref: { endpoint: m.endpoint, path: v.path },
                        }).catch((e) => setError(String(e)))
                      }
                    >
                      {v.path}
                    </button>
                    <span>
                      {v.error ??
                        `${amount(v.available)} 可用 / ${amount(v.total)}`}
                    </span>
                    {v.filesystem.startsWith("nfs") && (
                      <span className="performance-muted">{v.source}</span>
                    )}
                  </div>
                ))}
            </section>
          ))}
      </div>
      {!!sample?.shares?.length && (
        <section className="performance-card">
          <h2>共享挂载</h2>
          {sample.shares.map((share: any) => (
            <div className="shared-volume" key={share.key}>
              <div className="performance-head">
                <strong>{share.source}</strong>
                {share.confirmed && share.sample && (
                  <span>
                    {amount(share.sample.volume.available)} 可用 ·{" "}
                    {stamp(share.sample.stamp)}
                  </span>
                )}
              </div>
              <div className="performance-actions">
                {share.mounts.map((m: any) => (
                  <button
                    key={m.endpoint + m.volume.path}
                    onClick={() =>
                      void call("locate", {
                        ref: { endpoint: m.endpoint, path: m.volume.path },
                      }).catch((e) => setError(String(e)))
                    }
                  >
                    {m.name} · {m.volume.path}
                  </button>
                ))}
              </div>
              <label className="share-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed.includes(share.key)}
                  onChange={() =>
                    setConfirmed((old) =>
                      old.includes(share.key)
                        ? old.filter((v) => v !== share.key)
                        : [...old, share.key],
                    )
                  }
                />
                确认这些挂载属于同一网络和导出
              </label>
            </div>
          ))}
        </section>
      )}
      <LinkPanel
        machines={machines.filter(
          (m) => m.kind === "ssh" && chosen.includes(m.endpoint),
        )}
        call={call}
      />
    </div>
  );
}

function LinkPanel({ machines, call }: { machines: Machine[]; call: Call }) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [addresses, setAddresses] = useState<Interface[][]>([[], []]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<any>();
  const [failure, setFailure] = useState("");
  const running = ["queued", "running"].includes(job?.state);
  const sourceId = machines.some((m) => m.endpoint === source)
    ? source
    : (machines[0]?.endpoint ?? "");
  const validTargets = machines.filter((m) => m.endpoint !== sourceId);
  const targetId = validTargets.some((m) => m.endpoint === target)
    ? target
    : (validTargets[0]?.endpoint ?? "");
  useEffect(() => {
    setFrom("");
    setTo("");
    setAddresses([[], []]);
    setFailure("");
    if (!sourceId || !targetId) return;
    let active = true;
    void Promise.all(
      [sourceId, targetId].map((endpoint) =>
        call("linkInterfaces", { endpoint }),
      ),
    )
      .then((value) => {
        if (!active) return;
        setAddresses(value);
        setFrom(value[0][0]?.address ?? "");
        setTo(value[1][0]?.address ?? "");
      })
      .catch((e) => {
        if (active) setFailure(String(e));
      });
    return () => {
      active = false;
    };
  }, [sourceId, targetId, call]);
  useEffect(() => {
    if (!running) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (!active) return;
      try {
        const value = document.hidden
          ? undefined
          : await call("performanceJob", { id: job.id });
        if (!active) return;
        if (value) setJob(value);
        if (!value || ["queued", "running"].includes(value.state))
          timer = setTimeout(check, 700);
      } catch (error) {
        if (active) setFailure(String(error));
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [running, job?.id, call]);
  const probe = async (measure: boolean) => {
    setFailure("");
    setLoading(true);
    try {
      setJob(
        await call("linkProbe", {
          source: { endpoint: sourceId, address: from },
          target: { endpoint: targetId, address: to },
          measure,
        }),
      );
    } catch (error) {
      setFailure(String(error));
    } finally {
      setLoading(false);
    }
  };
  const disabled = !from || !to || loading || running;
  if (machines.length < 2) return null;
  return (
    <section className="performance-card link-section">
      <div className="performance-head">
        <h2>链路诊断</h2>
        <span>服务器直连</span>
      </div>
      <div className="link-selectors">
        {[
          [sourceId, setSource, from, setFrom, machines],
          [targetId, setTarget, to, setTo, validTargets],
        ].map((row, i) => {
          const [value, set, address, setAddress, options] = row as [
            string,
            (v: string) => void,
            string,
            (v: string) => void,
            Machine[],
          ];
          return (
            <fieldset key={i}>
              <legend>{i === 0 ? "源端" : "目标端"}</legend>
              <select
                aria-label={i === 0 ? "源机器" : "目标机器"}
                value={value}
                disabled={running}
                onChange={(e) => set(e.target.value)}
              >
                {options.map((m) => (
                  <option key={m.endpoint} value={m.endpoint}>
                    {m.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={i === 0 ? "源网卡" : "目标网卡"}
                value={address}
                disabled={running}
                onChange={(e) => setAddress(e.target.value)}
              >
                {!addresses[i].length && <option value="">等待接口</option>}
                {addresses[i].map((a) => (
                  <option key={a.device + a.address} value={a.address}>
                    {a.device} · {a.address}
                  </option>
                ))}
              </select>
            </fieldset>
          );
        })}
      </div>
      <div className="performance-actions">
        <button disabled={disabled} onClick={() => void probe(false)}>
          检查连通
        </button>
        <button disabled={disabled} onClick={() => void probe(true)}>
          双向测速 · 每方向 64 MiB
        </button>
        {running && (
          <button
            onClick={() =>
              void call("performanceCancel", { id: job.id }).catch((e) =>
                setFailure(String(e)),
              )
            }
          >
            取消
          </button>
        )}
      </div>
      {running && <p role="status">{job.progress ?? "等待测速"}</p>}
      {job?.state === "cancelled" && <p role="status">已取消</p>}
      <Failure
        message={failure || job?.error || job?.result?.measureError || ""}
      />
      {job?.result && <LinkResult value={job.result} />}
    </section>
  );
}

export function LinkResult({ value }: { value: any }) {
  const names = [value.source, value.target];
  const max = Math.max(
    1,
    ...(value.directions ?? []).map((d: any) => d.bitsPerSecond),
  );
  return (
    <div className="link-results">
      {value.routes.map((r: any, i: number) => (
        <div key={r.address} className="link-route">
          <strong>{names[i]}</strong>
          <span>
            {r.device} · {r.address} → {r.peer}
          </span>
          <span>
            {r.tcp === "reachable"
              ? `TCP/${value.port} · ${elapsed(r.connectMs)}`
              : `TCP/${value.port} 未通 · ${r.tcpError ?? ""}`}
          </span>
          <span>
            {r.rdma.length
              ? "RDMA · " + r.rdma.join("、")
              : "本机未发现 RDMA 设备"}
          </span>
        </div>
      ))}
      {value.directions.map((d: any, i: number) => (
        <div className="performance-bar-row" key={i}>
          <span>
            {names[i]} → {names[1 - i]}
          </span>
          <div className="performance-bar">
            <span style={{ width: (100 * d.bitsPerSecond) / max + "%" }} />
          </div>
          <strong>{(d.bitsPerSecond / 1e9).toFixed(1)} Gbit/s</strong>
          <span className="performance-muted">
            {amount(d.bytes)} · {elapsed(d.elapsedMs)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Timeline({
  stages,
  lanes,
  total,
}: {
  stages: TimelineStage[];
  lanes: { id: string; label: string; stageCount?: number }[];
  total: number;
}) {
  const [picked, setPicked] = useState<TimelineStage>();
  useEffect(() => setPicked(undefined), [stages]);
  const end = stages.reduce(
    (n, s) => Math.max(n, s.offsetMs + s.durationMs),
    Math.max(1, total),
  );
  const legend = [...new Set(stages.map((s) => s.kind))];
  return (
    <div className="timeline">
      <div className="timeline-legend">
        {legend.map((kind) => (
          <span key={kind} data-phase={kind}>
            {labels[kind] ?? kind}
          </span>
        ))}
      </div>
      <div className="timeline-scale">
        <span>0</span>
        <span>{elapsed(end / 2)}</span>
        <span>{elapsed(end)}</span>
      </div>
      {lanes.map((lane) => {
        const row = stages.filter((s) => (s.endpoint ?? s.kind) === lane.id);
        const occupied: number[] = [];
        const layout = [...row]
          .sort((a, b) => a.offsetMs - b.offsetMs)
          .map((stage) => {
            const vacant = occupied.findIndex(
              (until) => until <= stage.offsetMs,
            );
            const track = vacant < 0 ? occupied.length : vacant;
            occupied[track] = stage.offsetMs + stage.durationMs;
            return { stage, track };
          });
        return (
          <div className="timeline-lane" key={lane.id}>
            <span>{lane.label}</span>
            {row.length ? (
              <div
                className="timeline-track"
                style={{ minHeight: Math.max(24, occupied.length * 22 + 4) }}
              >
                {layout.map(({ stage: s, track }, index) => (
                  <button
                    type="button"
                    data-phase={s.kind}
                    key={index}
                    style={{
                      left: (100 * s.offsetMs) / end + "%",
                      width: (100 * s.durationMs) / end + "%",
                      top: track * 22 + 2,
                    }}
                    aria-label={`${s.label || labels[s.kind]} · ${elapsed(s.durationMs)}`}
                    title={`${s.label || labels[s.kind]} · ${elapsed(s.durationMs)}`}
                    onClick={() => setPicked(s)}
                  >
                    {s.durationMs / end >= 0.055
                      ? s.label || labels[s.kind]
                      : ""}
                  </button>
                ))}
              </div>
            ) : (
              <span className="performance-muted">
                {lane.stageCount ? "本页无阶段" : "未采集"}
              </span>
            )}
          </div>
        );
      })}
      {picked && (
        <div className="timeline-selection">
          <strong>{picked.label || labels[picked.kind]}</strong>
          <span>
            开始 {elapsed(picked.offsetMs)} · 耗时 {elapsed(picked.durationMs)}
          </span>
          {picked.bytes != null && <span>{amount(picked.bytes)}</span>}
        </div>
      )}
    </div>
  );
}

export function TransferReport({ job }: { job: any }) {
  const timing = job.result?.timing as TransferTimingRecord | undefined;
  if (!timing)
    return <p className="performance-muted">本次任务暂无阶段记录。</p>;
  const stages = timing.spans.map((s) => ({
    kind: s.phase,
    offsetMs: s.startMs,
    durationMs: s.durationMs,
  }));
  const lanes = ["read", "write", "verify"].map((id) => ({
    id,
    label: labels[id],
  }));
  return (
    <section className="performance-card">
      <div className="performance-head">
        <h2>经 Wayfarer 的文件传输</h2>
        <strong>{elapsed(timing.executionMs)}</strong>
      </div>
      <div className="stage-summary">
        {lanes.map((lane) => (
          <span key={lane.id}>
            {lane.label}{" "}
            <strong>
              {elapsed(timing.totals[lane.id as keyof typeof timing.totals])}
            </strong>
          </span>
        ))}
        <span>
          数据量 <strong>{amount(job.bytes)}</strong>
        </span>
      </div>
      <p className="performance-muted">
        读取与写入含通道开销。阶段可重叠，右上为执行总耗时。
      </p>
      <Timeline stages={stages} lanes={lanes} total={timing.executionMs} />
      {timing.clipped && (
        <p className="performance-muted">
          时间线显示最近 96 段，阶段累计耗时覆盖整个任务。
        </p>
      )}
    </section>
  );
}

function sameRef(a: Ref, b: Ref) {
  return a.endpoint === b.endpoint && a.path === b.path;
}

export function RunsPanel({ call }: { call: Call }) {
  const [index, setIndex] = useState<Profile[]>([]);
  const [first, setFirst] = useState<any>();
  const [second, setSecond] = useState<any>();
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(false);
  const [node, setNode] = useState<string>();
  const [selectedRun, setSelectedRun] = useState(0);
  const shown = selectedRun === 1 && second ? second : first;
  useEffect(() => {
    let active = true;
    void call("runProfile")
      .then((value) => {
        if (active) setIndex(value);
      })
      .catch((error) => {
        if (active) setFailure(String(error));
      });
    return () => {
      active = false;
    };
  }, [call]);
  const load = async (slot: number, ref?: Ref) => {
    setFailure("");
    setLoading(true);
    try {
      const result = ref
        ? await call("runProfile", { ref })
        : await call("pickProfile");
      if (result) {
        (slot === 0 ? setFirst : setSecond)(result);
        if (slot === 0) setNode(undefined);
        if (!ref) setIndex(await call("runProfile"));
      }
    } catch (error) {
      setFailure(String(error));
    } finally {
      setLoading(false);
    }
  };
  const page = async (offset: number) => {
    setLoading(true);
    setFailure("");
    try {
      (selectedRun === 1 && second ? setSecond : setFirst)(
        await call("runProfile", { ref: shown.ref, offset }),
      );
    } catch (error) {
      setFailure(String(error));
    } finally {
      setLoading(false);
    }
  };
  const reports = [first, second].filter(Boolean);
  const total = Math.max(1, ...reports.map((v) => v.durationMs));
  const selected =
    shown?.nodes.filter((n: any) => !node || n.endpoint === node) ?? [];
  const lanes = selected.map((n: any) => ({
    id: n.endpoint,
    label: n.label,
    stageCount: n.stageCount,
  }));
  const visibleStages = (shown?.stages ?? []).filter(
    (s: TimelineStage) => !node || s.endpoint === node,
  );
  const mismatched =
    second &&
    (first?.samples !== second.samples ||
      first?.dataset !== second.dataset ||
      first?.commit !== second.commit);
  const slowest = first?.longest;
  return (
    <div className="performance-page">
      <section className="performance-card">
        <h1>运行报告</h1>
        <div className="run-selectors">
          {[first, second].map((v, i) => (
            <div key={i}>
              <label>
                {i === 0 ? "查看运行" : "对照运行"}
                <select
                  value={v ? index.findIndex((p) => sameRef(p.ref, v.ref)) : -1}
                  disabled={loading}
                  onChange={(e) => {
                    const chosen = index[Number(e.target.value)];
                    if (chosen) void load(i, chosen.ref);
                    else (i === 0 ? setFirst : setSecond)(undefined);
                  }}
                >
                  <option value={-1}>
                    {i === 0 ? "选择记录" : "选一份记录"}
                  </option>
                  {index.map((p, ix) => (
                    <option key={ix} value={ix}>
                      {p.label} · {p.project}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={loading} onClick={() => void load(i)}>
                打开文件…
              </button>
            </div>
          ))}
        </div>
        <Failure message={failure} />
        {loading && <p role="status">读取运行记录…</p>}
      </section>
      {!!reports.length && (
        <section className="performance-card">
          <div className="performance-head">
            <h2>总耗时</h2>
            {slowest && (
              <span>
                {first.nodes.length > 1 ? "各节点累计最多" : "耗时最多"} ·{" "}
                {slowest.label ?? labels[slowest.kind]} ·{" "}
                {elapsed(slowest.durationMs)}
              </span>
            )}
          </div>
          {reports.map((v) => (
            <div
              className="performance-bar-row"
              key={v.ref.endpoint + v.ref.path}
            >
              <span>{v.label}</span>
              <div className="performance-bar">
                <span style={{ width: (100 * v.durationMs) / total + "%" }} />
              </div>
              <strong>{elapsed(v.durationMs)}</strong>
              <span className="performance-muted">
                {v.samples
                  ? ((v.samples * 1000) / v.durationMs).toFixed(2) + " 样本/秒"
                  : "样本数未记录"}
              </span>
            </div>
          ))}
          {mismatched && (
            <p className="performance-muted">
              两次运行的样本数、数据版本或代码版本有差异。
            </p>
          )}
          {second && (
            <div className="stage-summary">
              {Object.keys(labels)
                .filter((k) =>
                  [first, second].some((r) => r?.phaseTotals?.[k] != null),
                )
                .map((k) => (
                  <span key={k}>
                    {labels[k]}{" "}
                    <strong>
                      {elapsed(first?.phaseTotals?.[k])} /{" "}
                      {elapsed(second.phaseTotals?.[k])}
                    </strong>
                  </span>
                ))}
            </div>
          )}
        </section>
      )}
      {shown && (
        <section className="performance-card">
          <div className="performance-head">
            <h2>各节点启动后的时间线</h2>
            {first && second && (
              <div className="performance-actions">
                {[first, second].map((report, index) => (
                  <button
                    key={index}
                    aria-pressed={selectedRun === index}
                    onClick={() => {
                      setSelectedRun(index);
                      setNode(undefined);
                    }}
                  >
                    {report.label}
                  </button>
                ))}
              </div>
            )}
            <select
              aria-label="筛选节点"
              value={node ?? ""}
              onChange={(e) => setNode(e.target.value || undefined)}
            >
              <option value="">所有节点</option>
              {shown.nodes.map((n: any) => (
                <option value={n.endpoint} key={n.endpoint}>
                  {n.label}
                </option>
              ))}
            </select>
          </div>
          <Timeline
            stages={visibleStages}
            lanes={lanes}
            total={shown.durationMs}
          />
          <div className="performance-actions">
            {shown.offset > 0 && (
              <button
                disabled={loading}
                onClick={() => void page(Math.max(0, shown.offset - 100))}
              >
                上一段
              </button>
            )}
            {shown.next != null && (
              <button disabled={loading} onClick={() => void page(shown.next)}>
                下一段
              </button>
            )}
            <button
              onClick={() =>
                void call("openPerformanceFile", { ref: shown.ref }).catch(
                  (e) => setFailure(String(e)),
                )
              }
            >
              运行记录
            </button>
          </div>
          <details className="report-details">
            <summary>输入和原始日志</summary>
            <p>
              {shown.project} · 数据版本 {shown.dataset} · 代码 {shown.commit}
            </p>
            {selected.map((n: any) => (
              <div className="performance-actions" key={n.endpoint}>
                <span>
                  {n.label} ·{" "}
                  {n.startedAt == null
                    ? "未记录启动时间"
                    : new Date(n.startedAt).toLocaleString()}
                </span>
                {n.log && (
                  <button
                    onClick={() =>
                      void call("openPerformanceFile", { ref: n.log }).catch(
                        (e) => setFailure(String(e)),
                      )
                    }
                  >
                    原始日志
                  </button>
                )}
              </div>
            ))}
          </details>
        </section>
      )}
    </div>
  );
}

export function JobPerformance({ id, call }: { id: string; call: Call }) {
  const [job, setJob] = useState<any>();
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let active = true;
    let next: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (!active) return;
      try {
        const value = document.hidden
          ? undefined
          : await call("performanceJob", { id });
        if (!active) return;
        if (value) setJob(value);
        if (!value || ["queued", "running"].includes(value.state))
          next = setTimeout(load, 1000);
      } catch (error) {
        if (active) setFailure(String(error));
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(next);
    };
  }, [id, call]);
  return (
    <div className="performance-page">
      <Failure
        message={failure || job?.error || job?.result?.measureError || ""}
      />
      {!job && !failure && <p role="status">读取任务…</p>}
      {job?.kind === "transfer" && <TransferReport job={job} />}
      {job?.kind === "linkProbe" && job?.result && (
        <section className="performance-card">
          <h1>服务器直连</h1>
          <LinkResult value={job.result} />
        </section>
      )}
      {["queued", "running"].includes(job?.state) && (
        <p role="status">{job.progress ?? "任务进行中"}</p>
      )}
      {job && (
        <div className="performance-actions">
          <button
            onClick={() =>
              void call("openJobRecord", { id }).catch((e) =>
                setFailure(String(e)),
              )
            }
          >
            原始任务记录
          </button>
        </div>
      )}
    </div>
  );
}
