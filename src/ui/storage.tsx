import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./storage.css";
declare const acquireVsCodeApi: () => {
  postMessage: (v: any) => void;
  getState: () => any;
  setState: (v: any) => void;
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
const bytes = (v: any) =>
  v == null
    ? "未知"
    : v >= 2 ** 30
      ? (v / 2 ** 30).toFixed(2) + " GiB"
      : v >= 2 ** 20
        ? (v / 2 ** 20).toFixed(1) + " MiB"
        : v >= 1024
          ? (v / 1024).toFixed(1) + " KiB"
          : v + " B";
function App() {
  const saved = useRef(api.getState() ?? {}).current;
  const [endpoints, setEndpoints] = useState<any[]>([]),
    [snapshots, setSnapshots] = useState<any[]>([]);
  const [ref, setRef] = useState<any>(saved.ref),
    [draft, setDraft] = useState(saved.ref?.path ?? ""),
    [volume, setVolume] = useState<any>();
  const [id, setId] = useState<string>(saved.id ?? ""),
    [result, setResult] = useState<any>(),
    [job, setJob] = useState<any>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("directories");
  const [directory, setDirectory] = useState<string | undefined>(
      saved.directory,
    ),
    [offset, setOffset] = useState(0);
  const [baseline, setBaseline] = useState(""),
    [comparison, setComparison] = useState<any>(),
    [compareOffset, setCompareOffset] = useState(0);
  const compareRevision = useRef(0);
  const compare = async (before: string, after: string, page = 0) => {
    const revision = ++compareRevision.current;
    if (!before || !after) {
      setComparison(undefined);
      return;
    }
    try {
      const value = await rpc("storageCompare", {
        before,
        after,
        offset: page,
        limit: 50,
      });
      if (compareRevision.current === revision) {
        setComparison(value);
        setCompareOffset(page);
      }
    } catch (e) {
      if (compareRevision.current === revision) setError(String(e));
    }
  };
  const generation = useRef(0),
    jobRef = useRef<any>(undefined);
  jobRef.current = job;
  const load = async (snapshotId: string, dir?: string, page = 0) => {
    const current = ++generation.current;
    setBusy(true);
    try {
      const value = await rpc("storageResult", {
        id: snapshotId,
        directory: dir,
        offset: page,
        limit: 50,
      });
      if (current === generation.current) {
        setResult(value);
        setDirectory(value.directory?.id ?? dir);
        setOffset(page);
        setError("");
      }
    } catch (e) {
      if (current === generation.current) setError(String(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const select = (next: any) => {
    generation.current++;
    compareRevision.current++;
    setBaseline("");
    setComparison(undefined);
    setBusy(false);
    setRef(next);
    setDraft(next.path);
    setVolume(undefined);
    setResult(undefined);
    setId("");
    jobRef.current = undefined;
    setJob(undefined);
    setDirectory(undefined);
    setOffset(0);
    setError("");
  };
  useEffect(() => {
    let active = true;
    rpc("bootstrap")
      .then((v) => {
        if (!active) return;
        setEndpoints(v.endpoints);
        setSnapshots(v.snapshots);
        const r = v.target ??
          saved.ref ?? {
            endpoint: v.endpoints[0]?.id,
            path: v.endpoints[0]?.root,
          };
        setRef(r);
        setDraft(r.path);
        if (saved.id && !v.target) {
          setId(saved.id);
          void load(saved.id, saved.directory);
        }
        const task = v.jobs.find(
          (j: any) => j.ref?.endpoint === r.endpoint && j.ref?.path === r.path,
        );
        if (task) {
          jobRef.current = task;
          setJob(task);
          setId(task.id);
        }
      })
      .catch((e) => active && setError(String(e)));
    const notify = (v: any) => {
      if (v.type === "capacity") {
        setVolume(v.value);
        return;
      }
      if (v.type === "capacityError") {
        setError(v.error);
        return;
      }
      if (v.type === "target") {
        select(v.ref);
        return;
      }
      if (v.type === "job" && v.job.id === jobRef.current?.id) {
        setJob(v.job);
        if (["completed", "cancelled", "failed"].includes(v.job.state)) {
          setId(v.job.id);
          void load(v.job.id);
          void rpc("storageSnapshots", { includeUnavailable: true })
            .then(setSnapshots)
            .catch(() => {});
        }
      }
    };
    listeners.add(notify);
    return () => {
      active = false;
      generation.current++;
      listeners.delete(notify);
    };
  }, []);
  useEffect(() => {
    if (!ref) return;
    let active = true;
    rpc("watchCapacity", { ref }).catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [ref?.endpoint, ref?.path]);
  useEffect(() => {
    void compare(baseline, id);
  }, [baseline, id]);
  useEffect(() => {
    api.setState({ ref, id, directory });
  }, [ref, id, directory]);
  const start = async () => {
    if (!ref || busy) return;
    const revision = ++generation.current;
    compareRevision.current++;
    setBaseline("");
    setComparison(undefined);
    setBusy(true);
    setError("");
    try {
      const r = { ...ref, path: draft };
      if (r.path !== ref.path) setRef(r);
      const task = await rpc("storageScan", {
        ref: r,
        operationId: crypto.randomUUID(),
      });
      if (revision !== generation.current) return;
      jobRef.current = task;
      setJob(task);
      setId(task.id);
      setResult(undefined);
      setDirectory(undefined);
      const latest = await rpc("job", { id: task.id, fields: ["summary"] });
      if (revision !== generation.current) return;
      jobRef.current = latest;
      setJob(latest);
      if (["completed", "cancelled", "failed"].includes(latest.state)) {
        await load(task.id);
        setSnapshots(
          await rpc("storageSnapshots", { includeUnavailable: true }),
        );
      }
    } catch (e) {
      if (revision === generation.current) setError(String(e));
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  };
  const running = job && ["running", "queued"].includes(job.state);
  const data = result?.directory,
    summary = result?.snapshot;
  const locate = (p: string) =>
    rpc("locate", { ref: { ...ref, path: p } }).catch((e) =>
      setError(String(e)),
    );
  return (
    <main>
      <header>
        <div>
          <h1>存储占用</h1>
          <p>目录、实际占盘与共享文件</p>
        </div>

      </header>
      <section className="controls">
        <button
          disabled={!ref}
          onClick={() =>
            void rpc("refreshCapacity").catch((e) => setError(String(e)))
          }
        >
          刷新容量
        </button>
        <select
          aria-label="机器与磁盘"
          value={ref?.endpoint ?? ""}
          onChange={(e) => {
            const ep = endpoints.find((v) => v.id === e.target.value);
            select({ endpoint: ep.id, path: ep.root });
          }}
        >
          {endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <input
          aria-label="统计目录"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void start();
          }}
        />
        <button
          className="primary"
          disabled={busy || running}
          onClick={() => void start()}
        >
          {busy ? "读取中…" : id ? "重新统计" : "统计目录"}
        </button>
      </section>
      {volume && (
        <section className="volume">
          <div>
            <span>
              {volume.volumeCapacityKind === "virtual-filesystem"
                ? "WSL 虚拟容量"
                : "卷容量"}
            </span>
            <strong>{bytes(volume.total)}</strong>
          </div>
          <div>
            <span>
              {volume.volumeCapacityKind === "virtual-filesystem"
                ? "虚拟文件系统余量"
                : "剩余空间"}
            </span>
            <strong
              className={volume.available / volume.total < 0.1 ? "warning" : ""}
            >
              {bytes(volume.available)}
            </strong>
          </div>
          <div>
            <span>
              挂载位置 · {new Date(volume.stamp).toLocaleTimeString()}
            </span>
            <button className="path" onClick={() => void locate(volume.mount)}>
              {volume.mount}
            </button>
          </div>
          <div className="meter">
            <i
              style={{
                width:
                  Math.min(100, 100 * (1 - volume.available / volume.total)) +
                  "%",
              }}
            />
          </div>
        </section>
      )}
      {volume?.physicalBudget && (
        <p className="physical-budget">
          承载卷 {volume.physicalBudget.mount} 剩余{" "}
          <strong>{bytes(volume.physicalBudget.available)}</strong>；WSL
          新增写入受这份实际空间约束。
        </p>
      )}
      <section className="snapshot-line">
        <label>
          已保存分析{" "}
          <select
            aria-label="已保存分析"
            value={id}
            onChange={(e) => {
              const s = snapshots.find((x) => x.id === e.target.value);
              if (!s) return;
              generation.current++;
              compareRevision.current++;
              setBusy(false);
              setRef(s.ref);
              setDraft(s.ref.path);
              setId(s.id);
              setJob(undefined);
              setBaseline("");
              setComparison(undefined);
              if (s.available !== false) void load(s.id);
              else setResult(undefined);
            }}
          >
            <option value="">选择快照</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {new Date(s.stamp).toLocaleString()} · {s.ref.path}
                {s.available === false ? " · 索引已淘汰" : ""}
              </option>
            ))}
          </select>
        </label>
        {summary && (
          <span>
            {summary.files.toLocaleString()} 文件 ·{" "}
            {(summary.elapsedMs / 1000).toFixed(1)} 秒
          </span>
        )}
      </section>
      <p className="retention">
        保留 3 份索引，共 100 MiB。
        {snapshots.find((s) => s.id === id)?.available === false && (
          <strong>
            {" "}
            当前索引因
            {snapshots.find((s) => s.id === id)?.evictionReason ===
            "snapshot-count"
              ? "保留数量"
              : "空间预算"}
            已淘汰，目录结果已释放。
          </strong>
        )}
      </p>
      {result && (
        <section className="comparison">
          <label>
            对比基线{" "}
            <select
              aria-label="对比基线"
              value={baseline}
              onChange={(e) => setBaseline(e.target.value)}
            >
              <option value="">选择同目录的历史分析</option>
              {snapshots
                .filter(
                  (s) =>
                    s.id !== id &&
                    s.available !== false &&
                    s.ref.endpoint === ref?.endpoint &&
                    s.ref.path === ref?.path,
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {new Date(s.stamp).toLocaleString()}
                  </option>
                ))}
            </select>
          </label>
          {comparison && (
            <>
              <p>
                {new Date(comparison.before.stamp).toLocaleString()} →{" "}
                {new Date(comparison.after.stamp).toLocaleString()}
              </p>
              <p>
                目录已知占盘变化：
                {(comparison.after.rootStats?.allocatedBytesKnown ?? 0) >=
                (comparison.before.rootStats?.allocatedBytesKnown ?? 0)
                  ? "+"
                  : "−"}
                {bytes(
                  Math.abs(
                    (comparison.after.rootStats?.allocatedBytesKnown ?? 0) -
                      (comparison.before.rootStats?.allocatedBytesKnown ?? 0),
                  ),
                )}
              </p>
              <p>
                卷余量变化：
                {comparison.volumeAvailableDelta == null
                  ? "未知"
                  : (comparison.volumeAvailableDelta >= 0 ? "+" : "−") +
                    bytes(Math.abs(comparison.volumeAvailableDelta))}{" "}
                · 按两次卷采样计算，包含其他程序的写入与释放。
              </p>
              {(comparison.incomplete || comparison.coverageChanged) && (
                <p className="warning">
                  部分目录覆盖范围有差异，以下变化仅代表已读取内容。
                </p>
              )}
              <table>
                <thead>
                  <tr>
                    <th>目录</th>
                    <th>原占盘</th>
                    <th>现占盘</th>
                    <th>已知占盘变化</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((r: any) => (
                    <tr key={r.id}>
                      <td>
                        <button
                          className="path long-path"
                          onClick={() => void locate(r.path)}
                        >
                          {r.path}
                        </button>
                        {r.state === "added"
                          ? " · 新增"
                          : r.state === "removed"
                            ? " · 已移除"
                            : ""}
                      </td>
                      <td>{bytes(r.before?.allocatedBytesKnown ?? 0)}</td>
                      <td>{bytes(r.after?.allocatedBytesKnown ?? 0)}</td>
                      <td>
                        {r.allocatedDelta >= 0 ? "+" : "−"}
                        {bytes(Math.abs(r.allocatedDelta))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <footer>
                <button
                  disabled={!compareOffset}
                  onClick={() =>
                    void compare(baseline, id, Math.max(0, compareOffset - 50))
                  }
                >
                  上一页
                </button>
                <button
                  disabled={!comparison.hasMore}
                  onClick={() => void compare(baseline, id, compareOffset + 50)}
                >
                  下一页
                </button>
              </footer>
            </>
          )}
        </section>
      )}
      {job && (
        <section className="progress" role="status">
          <span>
            {(
              {
                queued: "排队中",
                running: "统计中",
                completed: "统计完成",
                cancelled: "统计已取消",
                failed: "统计异常",
              } as any
            )[job.state] ?? job.state}{" "}
            · {(job.files ?? 0).toLocaleString()} 文件
          </span>
          {running && (
            <button
              onClick={() =>
                void rpc("jobControl", { id: job.id, action: "cancel" }).catch(
                  (e) => setError(String(e)),
                )
              }
            >
              取消统计
            </button>
          )}
          {job.error && <span>{job.error}</span>}
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <nav className="crumb">
            <button onClick={() => void load(id)}>扫描根目录</button>
            {data && data.id !== summary.rootId && (
              <button onClick={() => void load(id, data.parent)}>上一级</button>
            )}
            <button
              className="path"
              onClick={() => void locate(data?.path ?? summary.root)}
            >
              {data?.path ?? summary.root}
            </button>
          </nav>
          <section className="totals">
            <article>
              <span>文件逻辑大小</span>
              <strong>{bytes(data?.logicalBytes)}</strong>
            </article>
            <article>
              <span>已分配空间 · 扫描内去重</span>
              <strong>
                {data?.errors > 0 ? "≥ " : ""}
                {bytes(data?.allocatedBytesKnown)}
              </strong>
              {data?.allocationUnknownFiles > 0 && (
                <small>
                  {data.allocationUnknownFiles} 个文件的分配空间未知
                </small>
              )}
            </article>
            <article>
              <span>硬链接目录项涉及空间</span>
              <strong>{bytes(data?.hardlinkBytes)}</strong>
              <small>按目录项累计，同一文件可能出现多次</small>
            </article>
          </section>
          {data && "reclaimableUpperBoundBytes" in data && (
            <p className="reclaim">
              整个扫描范围的文件块回收上界：
              {bytes(data.reclaimableUpperBoundBytes)}
              。已扣除范围外硬链接；实际释放量以清理后的卷余量核对。
            </p>
          )}
          <div className="tabs">
            <button
              aria-pressed={tab === "directories"}
              onClick={() => setTab("directories")}
            >
              子目录
            </button>
            <button
              aria-pressed={tab === "files"}
              onClick={() => setTab("files")}
            >
              扫描范围最大文件 · 100 项
            </button>
            <button
              aria-pressed={tab === "errors"}
              onClick={() => setTab("errors")}
            >
              覆盖范围 · {summary.errorCount} 项异常
            </button>
          </div>
          {tab === "directories" && (
            <>
              <table>
                <thead>
                  <tr>
                    <th>目录</th>
                    <th>实际占盘归属</th>
                    <th>逻辑大小</th>
                    <th>文件数</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r: any) => (
                    <tr key={r.id}>
                      <td>
                        <button
                          className="path"
                          onClick={() => void load(id, r.id)}
                          title={r.path}
                        >
                          {r.path.split(/[\\/]/).filter(Boolean).pop() ??
                            r.path}
                        </button>
                      </td>
                      <td>
                        {r.errors > 0 ? "≥ " : ""}
                        {bytes(r.allocatedBytesKnown)}
                        {r.allocationUnknownFiles > 0 ? " + 未知" : ""}
                      </td>
                      <td>{bytes(r.logicalBytes)}</td>
                      <td>{r.files.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!result.rows.length && (
                <p className="empty">
                  此目录下暂无已统计的子目录；直属文件包含在上方总量中。
                </p>
              )}
              <footer>
                <button
                  disabled={busy || offset === 0}
                  onClick={() =>
                    void load(id, directory, Math.max(0, offset - 50))
                  }
                >
                  上一页
                </button>
                <span>
                  {offset + 1}–{offset + result.rows.length}
                </span>
                <button
                  disabled={busy || !result.hasMore}
                  onClick={() => void load(id, directory, offset + 50)}
                >
                  下一页
                </button>
              </footer>
            </>
          )}
          {tab === "files" && (
            <table>
              <thead>
                <tr>
                  <th>文件路径</th>
                  <th>逻辑大小</th>
                  <th>实际占盘</th>
                  <th>链接数</th>
                </tr>
              </thead>
              <tbody>
                {summary.topFiles.map((f: any) => (
                  <tr key={f.path}>
                    <td className="long-path" title={f.path}>
                      {f.path}
                    </td>
                    <td>{bytes(f.logicalBytes)}</td>
                    <td>{bytes(f.allocatedBytes)}</td>
                    <td>{f.links}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === "errors" && (
            <div className="coverage">
              <p>
                {summary.incomplete ? "部分结果" : "扫描完成"} · 已跳过{" "}
                {summary.skippedLinks} 个链接、重解析点或其他卷入口。
              </p>
              <p>
                统计反映扫描期间的文件状态。硬链接只在扫描内归属一次；实际释放量以清理后的卷余量变化为准。
              </p>
              {summary.errors.map((e: any, i: number) => (
                <p key={i}>
                  <code>{e.path}</code>
                  <br />
                  {e.error}
                </p>
              ))}
            </div>
          )}
        </>
      )}
      {!result && !running && !error && (
        <section className="empty">
          选择目录后开始统计，或打开已保存分析。目录浏览与文件传输继续独立运行。
        </section>
      )}
      {volume?.wsl?.length > 0 && (
        <section className="relationships">
          <h2>WSL 存储关联</h2>
          {volume.wsl.map((w: any) => (
            <article key={w.distribution}>
              <strong>{w.distribution}</strong>
              {w.disks.map((d: any) => (
                <p key={d.path}>
                  <code>{d.path}</code> · {bytes(d.allocatedBytes)}
                  <span>
                    Windows 已计入这份磁盘，WSL 内部目录属于它的展开视图。
                  </span>
                </p>
              ))}
              {endpoints.find(
                (e) => e.kind === "wsl" && e.distro === w.distribution,
              ) && (
                <button
                  onClick={() => {
                    const e = endpoints.find(
                      (e) => e.kind === "wsl" && e.distro === w.distribution,
                    );
                    select({ endpoint: e.id, path: e.root });
                  }}
                >
                  查看内部目录
                </button>
              )}
            </article>
          ))}
          <p>
            交换文件 {volume.swapFiles?.length ?? 0} 个 ·{" "}
            {bytes(
              volume.swapFiles?.reduce(
                (n: number, x: any) => n + (x.allocatedBytes ?? 0),
                0,
              ),
            )}
            ；活动状态待维护时核对。
          </p>
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
