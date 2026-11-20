import React, { useEffect, useState } from "react";
import { useVisibleQuery } from "./visibleQuery";
import type { Ref } from "../shared/types";
import type { PatrolGroup, PeerPair } from "../core/operations";
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
  direct: "服务器直传",
  other: "其他",
};

function Failure({ message }: { message: string }) {
  return message ? (
    <p className="resource-error" role="alert">
      {message}
    </p>
  ) : null;
}

export function FleetTools({machines,selectedPair,call,filter,onFilter}:{machines:Machine[];selectedPair:string[];call:Call;filter:string;onFilter:(id:string)=>void}){
  const [chosen, setChosen] = useState<string[]>(() =>
    machines.slice(0, 8).map((m) => m.endpoint),
  );
  const groupFilter=filter, setGroupFilter=onFilter;

  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [groups, setGroups] = useState<PatrolGroup[]>([]);
  const [groupId, setGroupId] = useState("daily");
  const [groupName, setGroupName] = useState("常用巡检");
  const [mounts, setMounts] = useState<Record<string, string[]>>({});
  const [pairs, setPairs] = useState<PeerPair[]>([]);
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState<any>();
  const [error, setError] = useState("");

  type Catalog = { groups: PatrolGroup[]; selected: string; pairs: PeerPair[] };
  const apply = (value: Catalog) => {
    setGroups(value.groups);
    setPairs(value.pairs);
    const group = value.groups.find((item) => item.id === value.selected);
    if (!group) return;
    setGroupId(group.id);
    setGroupName(group.name);
    const known = new Set(machines.map((machine) => machine.endpoint));
    setChosen(group.endpoints.filter((endpoint) => known.has(endpoint)));
    setConfirmed(group.confirmedShares);
    setMounts(group.mounts);
  };
  useEffect(() => {
    let current = true;
    void call("opsCatalog")
      .then((value) => {
        if (current) apply(value);
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [call]);
  const save = async (create = false) => {
    setSaving(true);
    try {
      const result = await call("opsGroupSave", {
        id: create ? undefined : groupId,
        name: groupName,
        endpoints: chosen,
        confirmedShares: confirmed,
        mounts,
      });
      apply(result);
      setGroupFilter(result.selected);
      setError("");
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };
  const focusMount = (endpoint: string, path: string) => {
    if (!chosen.includes(endpoint)) {
      if (chosen.length >= 8) {setError("巡检组已选八台机器，请先调整成员");return;}
      setChosen([...chosen,endpoint]);
    }
    setMounts((old) => {
      const paths = old[endpoint] ?? [];
      return {
        ...old,
        [endpoint]: paths.includes(path)
          ? paths.filter((value) => value !== path)
          : [...paths, path],
      };
    });
  };
  const visible = groupFilter
    ? machines.filter((m) => chosen.includes(m.endpoint))
    : machines;
  const ids = visible.map((m) => m.endpoint);

  const membership = JSON.stringify(ids);
  const pairKey = JSON.stringify(selectedPair);
  useVisibleQuery(
    async () => {
      const fleet = [],
        shares = [];
      const paired = selectedPair.length === 2 ? selectedPair : [];
      const rest = paired.length?[]:ids;
      const batches = paired.length ? [paired] : [];
      for (let i = 0; i < rest.length; i += 8)
        batches.push(rest.slice(i, i + 8));
      for (const endpoints of batches) {
        const page = await call("compare", {
          endpoints,
          confirmedShares: confirmed,
          trends: true,reuseRecent:true,
        });
        fleet.push(...page.machines);
        shares.push(...page.shares);
      }
      return { machines: fleet, shares };
    },
    (v) => {
      setSample(v);
      setError("");
    },
    (e) => setError(String(e)),
    [membership, pairKey, confirmed, call],
  );
  const shared =
    selectedPair.length === 2
      ? sample?.shares?.filter((sh: any) =>
          selectedPair.every((id) =>
            sh.mounts.some((m: any) => m.endpoint === id),
          ),
        )
      : [];
  return (
    <div className="performance-page">
      <section className="performance-card">
        <div className="performance-head">
          <h3>巡检组</h3>
          <select
            aria-label="巡检组筛选"
            value={groupFilter}
            onChange={async (e) => {
              const id = e.target.value;

              try {
                if (id) apply(await call("opsGroupSelect", { id }));
                setGroupFilter(id);
              } catch (err) {
                setError(String(err));
              }
            }}
          >
            <option value="">全部机器</option>
            {groups.map((g) => (
              <option value={g.id} key={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <details>
          <summary>管理巡检组</summary>
          <input
            aria-label="巡检组名称"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
          />
          {machines.map((m) => (
            <label key={m.endpoint}>
              <input
                type="checkbox"
                checked={chosen.includes(m.endpoint)}
                disabled={chosen.length >= 8 && !chosen.includes(m.endpoint)}
                onChange={() =>
                  setChosen((prev) =>
                    prev.includes(m.endpoint)
                      ? prev.filter((id) => id !== m.endpoint)
                      : [...prev, m.endpoint],
                  )
                }
              />
              {m.name}
            </label>
          ))}
          <button
            disabled={saving || !chosen.length}
            onClick={() => void save()}
          >
            保存本组
          </button>
          <button
            disabled={
              saving ||
              !chosen.length ||
              groups.some((g) => g.name === groupName.trim())
            }
            onClick={() => void save(true)}
          >
            另存为新组
          </button>
        </details>
        <Failure message={error} />
        {!selectedPair.length && sample?.machines?.map((m:any)=><details key={m.endpoint}><summary>{m.name} · 关注挂载</summary>{m.volumes.map((v:any)=><label key={v.path}><input type="checkbox" checked={(mounts[m.endpoint]??[]).includes(v.path)} onChange={()=>focusMount(m.endpoint,v.path)}/>{v.path}</label>)}</details>)}
        <button disabled={saving||!chosen.length} onClick={()=>void save()}>保存挂载与确认</button>
      </section>
      {!!shared?.length && (
        <section className="performance-card">
          <h2>共享挂载</h2>
          {confirmed.some(
            (key) => !sample.shares.some((share: any) => share.key === key),
          ) && (
            <p className="performance-muted">
              此前确认的挂载有变化或暂不可读，请核对来源。
            </p>
          )}
          {shared.map((share: any) => (
            <div className="shared-volume" key={share.key}>
              <div className="performance-head">
                <strong>{share.source}</strong>
                {share.confirmed && share.sample && (
                  <span>
                    <Capacity value={share.sample.volume} /> ·{" "}
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
      {selectedPair.length === 2 && (
        <LinkPanel
          key={selectedPair.join("|")}
          machines={machines.filter(
            (m) => m.kind === "ssh" && selectedPair.includes(m.endpoint),
          )}
          call={call}
          pairs={pairs}
          onPairs={setPairs}
        />
      )}
    </div>
  );
}

function Capacity({ value }: { value: any }) {
  if (value.error) return <span className="performance-muted">{value.error}</span>;
  const { available, total, trend } = value;
  const low = total > 0 && available / total <= 0.1;
  const high = Math.max(1, ...(trend ?? []).map((point: any) => point.available));
  return <div className="capacity-chart">
    <span className={low ? "capacity-low" : ""}>
      {amount(available)} 可用 / {amount(total)}{low && " · 余量低"}
    </span>
    {trend?.length > 1 && <details>
      <summary>容量趋势</summary>
      <div className="capacity-trend" role="img"
        aria-label={"最近采样可用空间，从 " + amount(trend[0].available) + " 到 " + amount(available)}>
        {trend.map((point: any) => <i key={point.stamp}
          title={stamp(point.stamp) + " · " + amount(point.available)}
          style={{ height: Math.max(6, 100 * point.available / high) + "%" }} />)}
      </div>
      <small>{stamp(trend[0].stamp)} → {stamp(trend.at(-1).stamp)} · 最新 {amount(available)}</small>
    </details>}
  </div>;
}

function LinkPanel({ machines, call, pairs, onPairs }: {
  machines: Machine[]; call: Call; pairs: PeerPair[]; onPairs: (pairs: PeerPair[]) => void;
}) {
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
        const value = await call("performanceJob", { id: job.id });
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
  const enabledPair = pairs.find((p) =>
    p.source.endpoint === sourceId && p.target.endpoint === targetId ||
    p.source.endpoint === targetId && p.target.endpoint === sourceId);
  const measured = job?.result?.directions?.length === 2 &&
    job.result.routes[0]?.address === from && job.result.routes[1]?.address === to;
  const savePair = async () => {
    setFailure(""); setLoading(true);
    try {
      const result = await call("peerPairSave", { remove: !!enabledPair, pair: enabledPair ?? {
        source: { endpoint: sourceId, address: from }, target: { endpoint: targetId, address: to },
      } });
      if (result) onPairs(result.pairs);
    } catch (error) { setFailure(String(error)); }
    finally { setLoading(false); }
  };
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
        <button disabled={loading || running || !enabledPair && (!from || !to || !measured)}
          onClick={() => void savePair()}>
          {enabledPair ? "停用此机器对直传" : "允许此机器对直传"}
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
  const route = job.result?.transport;
  const phases = ["read", "write", "direct", "verify"].filter((phase) =>
    stages.some((stage) => stage.kind === phase));
  const lanes = phases.map((id) => ({
    id,
    label: labels[id],
  }));
  return (
    <section className="performance-card">
      <div className="performance-head">
        <h2>{route?.directBytes
          ? route.relayBytes ? "私网直传与 SSH 中转" : "服务器私网直传"
          : "经 Wayfarer 的文件传输"}</h2>
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
      {route?.directBytes > 0 && <div className="stage-summary">
        <span>直传 <strong>{amount(route.directBytes)}</strong></span>
        <span>源盘读取 <strong>{elapsed(route.readMs)}</strong></span>
        <span>目标盘写入 <strong>{elapsed(route.writeMs)}</strong></span>
        <span>落盘确认 <strong>{elapsed(route.syncMs)}</strong></span>
      </div>}
      {!!route?.reasons?.length && <p className="performance-muted">切换到 SSH 中转 · {route.reasons.join(" · ")}</p>}
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

export function RunsPanel({ call, initialRef }: { call: Call; initialRef?:Ref }) {
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
      if(!ref)return;
      const result=await call("runProfile",{ref});
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
  useEffect(()=>{if(initialRef)void load(0,initialRef);},[initialRef]);
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
        <h1>作业耗时</h1>
        <details open={initialRef?undefined:true}><summary>选择与对照记录</summary><div className="run-selectors">
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

            </div>
          ))}
        </div></details>
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
    let pending = false;
    let unfinished = true;
    const load = async () => {
      if (!active || pending || !unfinished) return;
      pending = true;
      clearTimeout(next);
      try {
        const value = await call("performanceJob", { id });
        if (!active) return;
        setJob(value);
        unfinished = ["queued", "running"].includes(value.state);
        if (unfinished && !document.hidden) next = setTimeout(load, 1000);
      } catch (error) {
        if (active) setFailure(String(error));
      } finally { pending = false; }
    };
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    // Opening a job is an explicit read, including when the editor is restoring visibility.
    void load();
    return () => {
      active = false;
      clearTimeout(next);
      document.removeEventListener("visibilitychange", visible);
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
