import React, { useEffect, useRef, useState } from "react";
import type { Ref } from "../shared/types";
import { refKey } from "../shared/types";
import { rpc, subscribeJobs } from "./rpc";
const size = (bytes: number) =>
  bytes < 1024
    ? bytes + " B"
    : bytes < 1048576
      ? (bytes / 1024).toFixed(1) + " KiB"
      : (bytes / 1048576).toFixed(1) + " MiB";
export function DetailPanel({
  target,
  close,
  navigate,
  packages,
  onError,
}: {
  target: Ref;
  close: () => void;
  navigate: (r: Ref) => void;
  packages: () => void;
  onError: (s: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<any>(),
    [inventory, setInventory] = useState<any>(),
    [resource, setResource] = useState<any>(),
    [usage, setUsage] = useState<any>(),
    [loading, setLoading] = useState(false),
    [failure, setFailure] = useState("");
  const jobs = useRef(new Map<string, { kind: string; ref?: Ref }>()),
    generation = useRef(0);
  const load = async (refresh = false) => {
    const revision = ++generation.current;
    setLoading(true);
    setFailure("");
    try {
      const value = await rpc("inspect", { ref: target, refresh });
      if (revision === generation.current) {
        setSnapshot(value);
        if (value.inventory) setInventory(value.inventory);
        if (value.usage)
          setUsage({
            ...value.usage.value,
            ref: target,
            stamp: value.usage.stamp,
            job: { ...value.usage.value, state: "completed" },
          });
      }
    } catch (error) {
      if (revision === generation.current) setFailure(String(error));
    } finally {
      if (revision === generation.current) setLoading(false);
    }
  };
  const finish = async (id: string) => {
    const watched = jobs.current.get(id);
    if (!watched) return;
    const revision = generation.current;
    const job = await rpc("job", { id });
    if (revision !== generation.current) return;
    if (!["completed", "cancelled", "failed"].includes(job.state)) return;
    jobs.current.delete(id);
    if (watched.kind === "inventory") setInventory({ ...job.result, job });
    else setUsage({ ...job.result, job, ref: watched.ref, stamp: job.updated });
  };
  useEffect(() => {
    jobs.current.clear();
    setSnapshot(undefined);
    setInventory(undefined);
    setUsage(undefined);
    setResource(undefined);
    void load();
    const stop = subscribeJobs((event) => {
      const watched = jobs.current.get(event.job.id);
      if (!watched) return;
      if (watched.kind === "size")
        setUsage((old: any) => ({ ...old, ref: watched.ref, job: event.job }));
      else setInventory((old: any) => ({ ...old, job: event.job }));
      if (["completed", "cancelled", "failed"].includes(event.job.state))
        void finish(event.job.id).catch((e) => setFailure(String(e)));
    });
    return () => {
      generation.current++;
      jobs.current.clear();
      stop();
    };
  }, [refKey(target)]);
  const start = async (kind: string, ref = target, refresh = false) => {
    const revision = generation.current;
    try {
      const job = await rpc(
        kind,
        kind === "size"
          ? { ref }
          : { endpoint: target.endpoint, cwd: target.path, refresh },
      );
      if (revision !== generation.current) return;
      jobs.current.set(job.id, { kind, ref });
      if (kind === "size") setUsage({ job, ref });
      else setInventory({ job });
      await finish(job.id);
    } catch (e) {
      if (revision === generation.current) setFailure(String(e));
    }
  };
  const locate = (ref: Ref) => navigate(ref);
  const data = snapshot?.value,
    entry = data?.entry;
  const isDirectory = entry?.kind === "directory";
  const stamp = (value: number) => new Date(value).toLocaleString();
  return (
    <aside className="floating inspector" aria-label="详情与环境">
      <h2>
        详情与环境
        <button title="刷新当前资料" onClick={() => void load(true)}>
          <i className="codicon codicon-refresh" />
        </button>
        <button aria-label="关闭详情面板" onClick={close}>
          <i className="codicon codicon-close" />
        </button>
      </h2>
      <div className="inspector-body">
        <div className="inspect-location">
          <span>{data?.endpoint.name ?? target.endpoint}</span>
          <button className="path-link" onClick={() => locate(target)}>
            {target.path}
          </button>
        </div>
        {loading && <p role="status">读取当前目录资料…</p>}
        {failure && (
          <p className="failure" role="alert">
            {failure}
          </p>
        )}
        {entry && (
          <>
            <dl className="properties">
              <dt>类型</dt>
              <dd>
                {entry.linkType ??
                  (
                    {
                      directory: "目录",
                      file: "文件",
                      symlink: "软链接",
                      special: "特殊文件",
                      denied: "无权限",
                    } as Record<string, string>
                  )[entry.kind] ??
                  entry.kind}
              </dd>
              <dt>修改时间</dt>
              <dd>{stamp(entry.mtime)}</dd>
              <dt>权限</dt>
              <dd>{entry.mode?.toString(8)}</dd>
              <dt>身份</dt>
              <dd>{entry.identity}</dd>
              {entry.kind === "file" && (
                <>
                  <dt>大小</dt>
                  <dd>{size(entry.size)}</dd>
                </>
              )}
            </dl>
            {entry.target && (
              <section>
                <h3>链接目标</h3>
                <p>{entry.target}</p>
                {entry.resolved && (
                  <button
                    className="path-link"
                    onClick={() =>
                      locate({
                        endpoint: target.endpoint,
                        path: entry.resolved,
                      })
                    }
                  >
                    {entry.resolved}
                  </button>
                )}
              </section>
            )}
            {entry.error && <p className="failure">{entry.error}</p>}
            {isDirectory ? (
              <>
                <section>
                  <h3>项目与环境</h3>
                  <div className="tags">
                    {data.tags.map((tag: string) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  {data.markers.length ? (
                    data.markers.map((m: any) => (
                      <div className="inspect-row" key={m.name}>
                        {m.ref ? (
                          <button
                            className="path-link"
                            onClick={() =>
                              void rpc("open", { ref: m.ref }).catch((e) =>
                                onError(String(e)),
                              )
                            }
                          >
                            {m.name}
                          </button>
                        ) : (
                          <span>{m.name}</span>
                        )}
                        <span>{m.error ?? m.tag}</span>
                      </div>
                    ))
                  ) : (
                    <p>当前目录未发现项目标记</p>
                  )}
                  <button
                    onClick={() =>
                      void rpc("registerProject", {
                        ref: target,
                        remove: snapshot.registered,
                      })
                        .then(() => load())
                        .catch((e) => setFailure(String(e)))
                    }
                  >
                    {snapshot.registered ? "取消登记项目" : "登记项目"}
                  </button>
                </section>
                <section>
                  <button
                    onClick={() =>
                      void rpc("favoriteDirectory", { ref: target }).catch(
                        (e) => setFailure(String(e)),
                      )
                    }
                  >
                    加入常用工作区
                  </button>
                  <button
                    onClick={() =>
                      void rpc("environmentView", { ref: target }).catch((e) =>
                        setFailure(String(e)),
                      )
                    }
                  >
                    查看项目环境
                  </button>
                </section>
                <section>
                  <h3>工具清单</h3>
                  <div className="actions">
                    <button onClick={() => void start("inventory")}>
                      查询版本与环境
                    </button>
                    <button
                      onClick={() => void start("inventory", target, true)}
                    >
                      重新查询
                    </button>
                    <button onClick={packages}>包管理与命令预览</button>
                  </div>
                  {inventory?.stamp && (
                    <p className="stamp">查询于 {stamp(inventory.stamp)}</p>
                  )}
                  {inventory?.job &&
                    ["running", "queued", "paused"].includes(
                      inventory.job.state,
                    ) && (
                      <p role="status">
                        {inventory.job.progress ?? inventory.job.state}
                        <button
                          onClick={() =>
                            void rpc("jobControl", {
                              id: inventory.job.id,
                              action: "cancel",
                            })
                          }
                        >
                          取消查询
                        </button>
                      </p>
                    )}
                  {inventory?.job?.error && (
                    <p className="failure">{inventory.job.error}</p>
                  )}
                  {inventory?.value?.tools.map((tool: any) => (
                    <details key={tool.name + tool.path}>
                      <summary>
                        {tool.name}{" "}
                        <span>
                          {tool.error ??
                            tool.output?.trim().split("\n")[0] ??
                            "项目专用"}
                        </span>
                      </summary>
                      <button
                        className="path-link"
                        onClick={() =>
                          locate({ endpoint: target.endpoint, path: tool.path })
                        }
                      >
                        {tool.path}
                      </button>
                      <pre>
                        {JSON.stringify(
                          {
                            endpoint: tool.endpoint,
                            cwd: tool.cwd,
                            argv: tool.argv,
                            exitCode: tool.exitCode,
                          },
                          null,
                          2,
                        )}
                      </pre>
                      {tool.output && <pre>{tool.output}</pre>}
                    </details>
                  ))}
                  {inventory?.value?.projects.map((project: any) => (
                    <div
                      className="inspect-row"
                      key={refKey(project.value?.ref ?? project.ref)}
                    >
                      <button
                        className="path-link"
                        onClick={() =>
                          locate(project.value?.ref ?? project.ref)
                        }
                      >
                        {(project.value?.ref ?? project.ref).path}
                      </button>
                      <span>
                        {project.error ?? project.value.tags.join(" · ")}
                      </span>
                    </div>
                  ))}
                  {inventory?.value?.info?.paths &&
                    Object.entries(inventory.value.info.paths).map(
                      ([label, path]) => (
                        <div className="inspect-row" key={label}>
                          <span>{label}</span>
                          <button
                            className="path-link"
                            onClick={() =>
                              locate({
                                endpoint: target.endpoint,
                                path: String(path),
                              })
                            }
                          >
                            {String(path)}
                          </button>
                        </div>
                      ),
                    )}
                </section>
                <section>
                  <h3>占用</h3>
                  <button onClick={() => void rpc("storageView", { ref: target }).catch((e) => onError(String(e)))}>
                    统计当前目录
                  </button>
                  {data.locations.map((item: any) => (
                    <div
                      className="inspect-row"
                      key={item.label + item.ref.path}
                    >
                      <div>
                        <strong>{item.label}</strong>
                        <button
                          className="path-link"
                          onClick={() => locate(item.ref)}
                        >
                          {item.ref.path}
                        </button>
                      </div>
                      <button onClick={() => void rpc("storageView", { ref: item.ref }).catch((e) => onError(String(e)))}>
                        统计
                      </button>
                    </div>
                  ))}
                  {usage && (
                    <div className="usage-result">
                      <button
                        className="path-link"
                        onClick={() => locate(usage.ref)}
                      >
                        {usage.ref.path}
                      </button>
                      <p>
                        {size(usage.job.bytes)} · {usage.job.files} 个文件 ·{" "}
                        {usage.job.state}
                      </p>
                      {usage.stamp && (
                        <p className="stamp">统计于 {stamp(usage.stamp)}</p>
                      )}
                      {usage.incomplete && (
                        <p>部分路径读取失败 · {usage.errorCount} 项</p>
                      )}
                      {usage.job.error && (
                        <p className="failure">{usage.job.error}</p>
                      )}
                      {["running", "queued", "paused"].includes(
                        usage.job.state,
                      ) && (
                        <button
                          onClick={() =>
                            void rpc("jobControl", {
                              id: usage.job.id,
                              action: "cancel",
                            })
                          }
                        >
                          取消统计
                        </button>
                      )}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <button
                onClick={() =>
                  void rpc("open", { ref: target }).catch((e) =>
                    onError(String(e)),
                  )
                }
              >
                在编辑器打开
              </button>
            )}
            <section>
              <h3>端点资源</h3>
              <button
                onClick={() => {
                  const revision = generation.current;
                  void rpc("resources", { endpoint: target.endpoint })
                    .then((value) => {
                      if (revision === generation.current)
                        setResource({ stamp: Date.now(), value });
                    })
                    .catch((e) => setFailure(String(e)));
                }}
              >
                查询当前资源
              </button>
              {resource && (
                <>
                  <p className="stamp">查询于 {stamp(resource.stamp)}</p>
                  <pre>{JSON.stringify(resource.value, null, 2)}</pre>
                </>
              )}
            </section>
            <p className="stamp">资料查询于 {stamp(snapshot.stamp)}</p>
          </>
        )}
      </div>
    </aside>
  );
}
