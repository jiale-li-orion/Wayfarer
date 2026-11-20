import React, { useEffect, useState } from "react";
import type { Workload, WorkloadFile } from "../core/workloads";
import { useVisibleQuery } from "./visibleQuery";
type Call = (method: string, args?: any) => Promise<any>;
type Row = Omit<Workload, "files"> & { connection?: string };
const when = (t: number) => new Date(t).toLocaleString();
function status(w: Row) {
  if (w.state === "completed") return "已完成";
  if (w.state === "failed") return "失败";
  if (w.state === "exited" || w.observed === "exited") return "进程已退出";
  if (w.observed === "changed") return "原进程已退出 · PID 已复用";
  if (w.connection === "unavailable") return "观测暂不可读";
  if (w.connection === "offline") return "机器离线";
  return w.state === "running" || w.observed === "alive" ? "运行中" : "已登记";
}
function group(w: Row) {
  const s = status(w);
  return ["失败", "机器离线", "观测暂不可读"].includes(s)
    ? 1
    : s.includes("已退出") || s === "已完成"
      ? 2
      : 0;
}
export function WorkloadPanel({
  call,
  runId,
  select,
  onFile,
  onTransfer,
  machines,
}: {
  call: Call;
  runId?: string;
  select: (id?: string) => void;
  onFile: (f: WorkloadFile) => void;
  onTransfer: (id: string) => void;
  machines: { endpoint: string; name: string }[];
}) {
  const machineName = (id: string) =>
    machines.find((m) => m.endpoint === id)?.name ?? id;
  const [rows, setRows] = useState<Row[]>([]),
    [cursor, setCursor] = useState<string>(),
    [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [next, setNext] = useState<string>(),
    [info, setInfo] = useState<Workload & { connection?: string }>(),
    [transfers, setTransfers] = useState<any>();
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [tc, setTc] = useState<string>();
  useEffect(() => {
    setInfo(undefined);
    setTransfers(undefined);
    setTc(undefined);
    setError("");
  }, [runId]);
  useVisibleQuery(
    async () => {
      if (runId) {
        const [detail, jobs] = await Promise.all([
          call("workloadDetail", { runId, observe: true }),
          call("jobsPage", {
            kind: "transfer",
            workloadId: runId,
            limit: 20,
            cursor: tc,
          }),
        ]);
        return { detail, jobs };
      }
      return { list: await call("workloadsPage", { cursor, limit: 30 }) };
    },
    (v) => {
      if (v.detail) {
        setInfo(v.detail);
        setTransfers(v.jobs);
      }
      if (v.list) {
        setRows(v.list.items);
        setNext(v.list.cursor);
      }
      setError("");
    },
    (e) => setError(String(e)),
    [runId, cursor, tc, refresh, call],
  );
  const action = async (method: string, args: any) => {
    try {
      await call(method, args);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <main className="performance-page">
      <section className="performance-card">
        <header className="performance-head">
          <h1>
            {runId ? <button onClick={() => select()}>‹ 作业</button> : "作业"}
          </h1>
          <button onClick={() => setRefresh((n) => n + 1)}>刷新</button>
        </header>
        {error && <p role="alert">{error}</p>}
        {!runId ? (
          <>
            {["进行中", "需关注", "最近结束"].map((name, i) => {
              const items = rows.filter((w) => group(w) === i);
              return (
                items.length > 0 && (
                  <section key={name}>
                    <h2>{name}</h2>
                    {items.map((w) => (
                      <button
                        className="workload-row"
                        key={w.runId}
                        onClick={() => select(w.runId)}
                      >
                        <strong>{w.name}</strong>
                        <span>
                          {w.phase} {w.step != null ? "step " + w.step : ""}
                        </span>
                        <small>
                          {machineName(w.endpoint)} · {status(w)} ·{" "}
                          {when(w.progressAt ?? w.updated)}
                        </small>
                      </button>
                    ))}
                  </section>
                )
              );
            })}
            {!rows.length && !error && <p>此地图暂未收到实验运行。</p>}
            {pages.length > 1 && (
              <button
                onClick={() => {
                  setPages((p) => p.slice(0, -1));
                  setCursor(pages.at(-2));
                }}
              >
                上一页
              </button>
            )}
            {next && (
              <button
                onClick={() => {
                  setPages((p) => [...p, next]);
                  setCursor(next);
                }}
              >
                下一页
              </button>
            )}
          </>
        ) : (
          info &&
          info.runId === runId && (
            <>
              <div className="performance-head">
                <h2>{info.name}</h2>
              </div>
              <p>
                {machineName(info.endpoint)} · {status(info)} · {info.phase}{" "}
                {info.step != null ? "step " + info.step : ""} ·{" "}
                {when(info.progressAt ?? info.updated)}
                {info.connection === "offline" && info.observed === "alive"
                  ? " · 上次确认运行中"
                  : ""}
              </p>
              {info.lastObserved && <p>最近观测　{when(info.lastObserved)}</p>}
              {info.process && (
                <p>
                  PID {info.process.pid} · {info.process.identity}
                </p>
              )}
              {info.files.map((f) => (
                <button
                  key={JSON.stringify([f.kind, f.endpoint, f.path])}
                  title={f.path}
                  onClick={() => onFile(f)}
                >
                  {f.label ??
                    {
                      model: "模型分析",
                      profile: "作业耗时",
                      log: "日志",
                      artifact: "产物",
                    }[f.kind]}{" "}
                  · {f.path.split(/[\\/]/).slice(-2).join("/")}
                </button>
              ))}
              {transfers &&
                (transfers.active.length > 0 || transfers.total > 0) && (
                  <section>
                    <h3>关联传输</h3>
                    {[
                      ...new Set<string>(
                        [...transfers.active, ...transfers.history].map(
                          (j) => j.workloadPhase ?? "文件传输",
                        ),
                      ),
                    ].map((phase) => {
                      const tasks = [
                        ...transfers.active,
                        ...transfers.history,
                      ].filter(
                        (j) => (j.workloadPhase ?? "文件传输") === phase,
                      );
                      return (
                        <details key={phase} open>
                          <summary>
                            {phase} · 本页 {tasks.length} 项 ·{" "}
                            {(
                              tasks.reduce((a, j) => a + j.bytes, 0) / 1048576
                            ).toFixed(1)}{" "}
                            MiB
                          </summary>
                          {tasks.map((j) => (
                            <div key={j.id}>
                              <button onClick={() => onTransfer(j.id)}>
                                {j.progress ?? "文件传输"} · {j.state} ·{" "}
                                {(j.bytes / 1048576).toFixed(1)} MiB
                              </button>
                              {j.state === "paused" || j.state === "failed" ? (
                                <button
                                  onClick={() =>
                                    action("jobControl", {
                                      id: j.id,
                                      action: "resume",
                                    })
                                  }
                                >
                                  继续
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </details>
                      );
                    })}
                    {tc && (
                      <button onClick={() => setTc(undefined)}>最新</button>
                    )}
                    {transfers.cursor && (
                      <button onClick={() => setTc(transfers.cursor)}>
                        更早的传输
                      </button>
                    )}
                  </section>
                )}
            </>
          )
        )}
      </section>
    </main>
  );
}
