import React, { useEffect, useRef, useState } from "react";
import { rpc, subscribeJobs } from "./rpc";
import type { Job } from "../shared/types";
export function TaskPanel({
  close,
  onError,
}: {
  close: () => void;
  onError: (s: string) => void;
}) {
  const [active, setActive] = useState<Job[]>([]),
    [history, setHistory] = useState<Job[]>([]),
    [cursor, setCursor] = useState<string>(),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false);
  const pages = useRef<(string | undefined)[]>([undefined]),
    pageIndex = useRef(0);
  const [pageNumber, setPageNumber] = useState(1);
  const alive = useRef(true),
    pending = useRef(false),
    again = useRef(false);
  const load = async (next?: string) => {
    if (pending.current) {
      if (!next) again.current = true;
      return;
    }
    pending.current = true;
    setLoading(true);
    try {
      const page = await rpc("jobsPage", { cursor: next, limit: 30 });
      if (alive.current) {
        setActive(page.active);
        setHistory(page.history);
        setCursor(page.cursor);
        setTotal(page.total);
      }
    } catch (error) {
      if (alive.current) onError(String(error));
    } finally {
      pending.current = false;
      if (alive.current) {
        setLoading(false);
        if (again.current) {
          again.current = false;
          void load();
        }
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    const stop = subscribeJobs((event) => {
      const job = event.job as Job;
      if (["completed", "cancelled"].includes(job.state)) {
        setActive((old) => old.filter((j) => j.id !== job.id));
        void load(pages.current[pageIndex.current]);
      } else setActive((old) => [job, ...old.filter((j) => j.id !== job.id)]);
    });
    return () => {
      alive.current = false;
      stop();
    };
  }, []);
  const action = (id: string, action: string) =>
    void rpc("jobControl", { id, action }).catch((e) => onError(String(e)));
  const rows = (jobs: Job[]) =>
    jobs.map((job) => (
      <article key={job.id}>
        <div className="job-title">
          <strong>{job.kind}</strong>
          <span>{job.state}</span>
        </div>
        <p>{job.progress ?? job.id}</p>
        <p>
          {job.files} 项 · {(job.bytes / 1048576).toFixed(1)} MiB ·{" "}
          {new Date(job.created).toLocaleString()}
        </p>
        {job.pauseReason && (
          <p>
            {
              {
                shutdown: "窗口退出，等待接续",
                "process-interrupted": "进程中断，等待接续",
                network: "网络恢复后自动继续",
                user: "已主动暂停",
                "endpoint-disconnected": "端点已主动断开，连接后可继续",
              }[job.pauseReason]
            }
          </p>
        )}
        {!!job.cleanupPending?.length && (
          <p>暂存待清理 · {job.cleanupPending.length} 项</p>
        )}
        {job.error && <p className="failure">{job.error}</p>}
        <div className="actions">
          {["running", "queued"].includes(job.state) &&
            job.kind !== "package" && (
              <button onClick={() => action(job.id, "pause")}>暂停</button>
            )}
          {["paused", "failed"].includes(job.state) && (
            <button onClick={() => action(job.id, "resume")}>继续</button>
          )}
          {!["completed", "cancelled"].includes(job.state) && (
            <button onClick={() => action(job.id, "cancel")}>取消</button>
          )}
          {!!job.cleanupPending?.length && (
            <button
              onClick={() =>
                void rpc("jobCleanup", { id: job.id })
                  .then(() => load())
                  .catch((e) => onError(String(e)))
              }
            >
              清理任务暂存
            </button>
          )}
          <button
            onClick={() =>
              void rpc("jobDetails", { id: job.id }).catch((e) =>
                onError(String(e)),
              )
            }
          >
            详情与日志
          </button>
        </div>
      </article>
    ));
  return (
    <section className="floating jobs" aria-label="传输与后台任务">
      <h2>
        传输与后台任务
        <button
          title="诊断日志"
          onClick={() => void rpc("command", { name: "logs" })}
        >
          <i className="codicon codicon-output" />
        </button>
        <button aria-label="关闭任务面板" onClick={close}>
          <i className="codicon codicon-close" />
        </button>
      </h2>
      <div className="job-list">
        <h3>进行中与可恢复 · {active.length}</h3>
        {rows(active)}
        <h3>
          历史 · {total} · 第 {pageNumber} 页
        </h3>
        {rows(history)}
        {!active.length && !history.length && <p>暂无任务</p>}
        {pageNumber > 1 && (
          <button
            disabled={loading}
            onClick={() => {
              pageIndex.current--;
              setPageNumber(pageIndex.current + 1);
              void load(pages.current[pageIndex.current]);
            }}
          >
            上一页
          </button>
        )}
        {cursor && (
          <button
            disabled={loading}
            onClick={() => {
              pageIndex.current++;
              pages.current[pageIndex.current] = cursor;
              setPageNumber(pageIndex.current + 1);
              void load(cursor);
            }}
          >
            下一页
          </button>
        )}
        {loading && <p role="status">读取任务…</p>}
      </div>
    </section>
  );
}
