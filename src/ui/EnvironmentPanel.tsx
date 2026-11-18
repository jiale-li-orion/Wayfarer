import React, { useEffect, useRef, useState } from "react";
import type { Ref } from "../shared/types";
import { rpc, subscribeJobs } from "./rpc";
const ecosystemNames = {
  python: "Python · uv",
  node: "Node",
  java: "Java / Kotlin",
  android: "Android / Flutter",
  rust: "Rust",
};
export function EnvironmentPanel({
  target,
  navigate,
}: {
  target: Ref;
  navigate: (ref: Ref) => void;
}) {
  const [snapshot, setSnapshot] = useState<any>(),
    [ecosystem, setEcosystem] = useState("python"),
    [inventory, setInventory] = useState<any>(),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<any>(),
    [choice, setChoice] = useState<any>({}),
    [action, setAction] = useState("project-sync"),
    [packages, setPackages] = useState(""),
    [plan, setPlan] = useState<any>(),
    [plannedInput, setPlannedInput] = useState<any>(),
    [tools, setTools] = useState<any[]>([]),
    [managerOverride, setManagerOverride] = useState(""),
    [usage, setUsage] = useState<any>();
  const generation = useRef(0),
    watched = useRef(new Map<string, string>());
  const load = async (refresh = false) => {
    const g = ++generation.current;
    setBusy(true);
    setFailure("");
    try {
      const s = await rpc("inspect", {
        ref: target,
        environment: true,
        refresh,
      });
      if (g === generation.current) {
        setSnapshot(s);
        setChoice(s.value.choice ?? {});
        setPlan(undefined);
      }
    } catch (e) {
      if (g === generation.current) setFailure(String(e));
    } finally {
      if (g === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    setSnapshot(undefined);
    setInventory(undefined);
    setJob(undefined);
    setTools([]);
    setPlan(undefined);
    setUsage(undefined);
    watched.current.clear();
    void load();
    const stop = subscribeJobs((event) => {
      const kind = watched.current.get(event.job.id);
      if (!kind) return;
      setJob(event.job);
      if (["completed", "failed", "cancelled"].includes(event.job.state)) {
        watched.current.delete(event.job.id);
        const g = generation.current;
        void rpc("job", { id: event.job.id })
          .then((j) => {
            if (g !== generation.current) return;
            setJob(j);
            if (kind === "inventory") setInventory(j.result);
            if (kind === "size") setUsage(j.result);
            if (kind === "package") void load(true);
          })
          .catch((e) => setFailure(String(e)));
      }
    });
    return () => {
      generation.current++;
      watched.current.clear();
      stop();
    };
  }, [target.endpoint, target.path]);
  const run = async (kind: string, input: any) => {
    const g = generation.current;
    setFailure("");
    try {
      const j = await rpc(kind, input);
      if (g !== generation.current) return;
      setJob(j);
      watched.current.set(j.id, kind);
      const full = await rpc("job", { id: j.id });
      if (g !== generation.current) return;
      if (["completed", "failed", "cancelled"].includes(full.state)) {
        watched.current.delete(j.id);
        setJob(full);
        if (kind === "inventory") setInventory(full.result);
        if (kind === "size") setUsage(full.result);
        if (kind === "package") void load(true);
      }
    } catch (e) {
      if (g === generation.current) setFailure(String(e));
    }
  };
  const link = (path: string, file = false) => (
    <button
      className="path-link"
      onClick={() =>
        file
          ? void rpc("open", { ref: { ...target, path } }).catch((e) =>
              setFailure(String(e)),
            )
          : navigate({ ...target, path })
      }
    >
      {path}
    </button>
  );
  const env = snapshot?.value,
    py = env?.python;
  const discover = async () => {
    const g = generation.current;
    const result = await rpc("packageDiscover", {
      endpoint: target.endpoint,
      cwd: target.path,
    });
    if (g === generation.current) setTools(result);
    return result;
  };
  const manager =
    ecosystem === "python"
      ? "uv"
      : ecosystem === "node"
        ? managerOverride ||
          (env?.node?.manager?.split("@")[0] &&
          ["npm", "pnpm", "bun"].includes(env.node.manager.split("@")[0])
            ? env.node.manager.split("@")[0]
            : undefined) ||
          (env?.node?.locks?.includes("pnpm-lock.yaml")
            ? "pnpm"
            : env?.node?.locks?.some((n: string) => n.startsWith("bun.lock"))
              ? "bun"
              : "npm")
        : ecosystem === "java"
          ? "java"
          : ecosystem === "android"
            ? "flutter"
            : "rustup";
  const availableActions =
    ecosystem === "python"
      ? py?.project
        ? [
            "project-sync",
            "project-add",
            "project-remove",
            "project-update",
            "list",
            "python-installed",
            "python-dir",
            "tools",
            "tool-dir",
            "cache-info",
            "cache-prune",
          ]
        : [
            "list",
            "install",
            "uninstall",
            "update",
            "python-installed",
            "python-dir",
            "tools",
            "tool-dir",
            "cache-info",
            "cache-prune",
          ]
      : ecosystem === "node"
        ? [
            "list",
            "install",
            "uninstall",
            "update",
            "cache-info",
            "cache-clean",
          ]
        : ecosystem === "java"
          ? ["info"]
          : ecosystem === "android"
            ? ["info", "dependencies", "precache"]
            : ["list", "install", "uninstall", "update"];
  const selectedAction = availableActions.includes(action)
    ? action
    : availableActions[0];
  const labels: Record<string, string> = {
    "project-sync": "按锁文件同步环境",
    "project-add": "添加项目依赖",
    "project-remove": "移除项目依赖",
    "project-update": "更新指定项目依赖",
    list: "已安装清单",
    install: "安装",
    uninstall: "卸载",
    update: "更新指定条目",
    "python-installed": "已安装 Python",
    tools: "uv 工具清单",
    "tool-dir": "查询 uv 工具目录",
    "python-dir": "查询 uv Python 目录",
    "cache-info": "查询缓存位置",
    "cache-prune": "清理可回收缓存",
    "cache-clean": "清理缓存",
    info: "版本信息",
    dependencies: "获取项目依赖",
    precache: "预缓存",
  };
  const preview = async () => {
    setFailure("");
    setPlan(undefined);
    const g = generation.current;
    try {
      const discovered = tools.length ? tools : await discover();
      if (g !== generation.current) return;
      const tool =
        choice[manager] ??
        (manager === "java" ? choice.java : undefined) ??
        discovered.find((t: any) => t.name === manager)?.path;
      if (!tool)
        throw Error("当前端点尚未发现 " + manager + "；可指定绝对路径");
      const input: any = {
        endpoint: target.endpoint,
        cwd: target.path,
        manager,
        action: selectedAction,
        executable: tool,
      };
      if (packages.trim()) input.packages = packages.trim().split(/\s+/);
      if (
        manager === "uv" &&
        ["list", "install", "uninstall", "update"].includes(selectedAction)
      ) {
        input.python = choice.python ?? py?.selectedPython;
        if (!input.python) throw Error("先选择具体 Python 解释器");
      }
      if (ecosystem === "node" && choice.node) input.node = choice.node;
      if (
        manager === "uv" &&
        selectedAction.startsWith("project-") &&
        (choice.python ?? py?.selectedPython)
      )
        input.python = choice.python ?? py.selectedPython;
      const p = await rpc("packagePlan", input);
      if (g === generation.current) {
        setPlannedInput(input);
        setPlan(p);
      }
    } catch (e) {
      if (g === generation.current) setFailure(String(e));
    }
  };
  return (
    <div className="project-environment">
      <div className="action-row">
        <button disabled={busy} onClick={() => void load(true)}>
          刷新环境
        </button>
        <span>
          {snapshot
            ? new Date(snapshot.stamp).toLocaleString()
            : "读取项目声明…"}
        </span>
      </div>
      {failure && (
        <p role="alert" className="failure">
          {failure}
        </p>
      )}
      {env && (
        <>
          {env.errors.map((e: any) => (
            <p className="failure" key={e.file}>
              {e.file}：{e.error}
            </p>
          ))}
          <div className="action-row" role="tablist">
            {Object.entries(ecosystemNames).map(([id, label]) => (
              <button
                role="tab"
                aria-selected={ecosystem === id}
                key={id}
                onClick={() => {
                  setEcosystem(id);
                  setManagerOverride("");
                  setPackages("");
                  setPlan(undefined);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {ecosystem === "python" && (
            <section>
              <h3>{py.name ?? "Python"} · uv</h3>
              <dl>
                <dt>Python 要求</dt>
                <dd>{py.requiresPython ?? "项目未声明"}</dd>
                <dt>版本文件</dt>
                <dd>{py.versionFile ?? "—"}</dd>
                <dt>环境目标</dt>
                <dd>
                  {py.selectedPython
                    ? link(py.selectedPython)
                    : "选择项目解释器"}
                </dd>
              </dl>
              {py.selectionMissing && (
                <p className="failure">保存的解释器路径已失效，请重新选择。</p>
              )}
              {py.manifests.map((p: string) => (
                <div key={p}>{link(p, true)}</div>
              ))}
              <label>
                项目解释器
                <select
                  value={choice.python ?? py.selectedPython ?? ""}
                  onChange={(e) => {
                    setChoice({ ...choice, python: e.target.value });
                    setPlan(undefined);
                  }}
                >
                  <option value="">明确选择环境</option>
                  {py.interpreters.map((p: any) => (
                    <option value={p.path} key={p.path}>
                      {p.path} · {p.source}
                    </option>
                  ))}
                </select>
              </label>
              {py.workspaceMembers.length > 0 && (
                <p>uv 工作区成员：{py.workspaceMembers.join("、")}</p>
              )}
              <details>
                <summary>项目声明的依赖 · {py.declarations.length}</summary>
                {py.declarations.map((d: any, i: number) => (
                  <div key={i}>
                    {d.group} · {d.declaration}
                  </div>
                ))}
              </details>
            </section>
          )}
          {ecosystem === "node" && (
            <section>
              <h3>{env.node.name ?? "Node 项目"}</h3>
              <p>声明管理器：{env.node.manager ?? "—"}</p>
              <p>锁文件：{env.node.locks.join("、") || "—"}</p>
              {env.node.locks.length > 1 && (
                <p>存在多个锁文件，执行前核对管理器。</p>
              )}
              <pre>{JSON.stringify(env.node.engines, null, 2)}</pre>
              {env.node.manifest && link(env.node.manifest, true)}
              <details>
                <summary>
                  项目声明的依赖 · {env.node.declarations.length}
                </summary>
                {env.node.declarations.map((d: any, i: number) => (
                  <div key={i}>
                    {d.group} · {d.name} {d.declaration}
                  </div>
                ))}
              </details>
            </section>
          )}
          {ecosystem === "java" && (
            <section>
              <h3>JDK 与构建</h3>
              {env.java.javaHome && link(env.java.javaHome)}
              {env.java.wrappers.map((p: string) => (
                <div key={p}>{link(p, true)}</div>
              ))}
              {env.java.manifests.map((p: string) => (
                <div key={p}>{link(p, true)}</div>
              ))}
            </section>
          )}
          <details>
            <summary>Wayfarer 项目执行选择</summary>
            <p>绝对路径；作用于本插件的项目操作。</p>
            {["python", "uv", "node", "java"].map((k) => (
              <label key={k}>
                {k}
                <input
                  value={choice[k] ?? ""}
                  onChange={(e) => {
                    setChoice({ ...choice, [k]: e.target.value });
                    setPlan(undefined);
                  }}
                />
              </label>
            ))}
            <button
              onClick={() => {
                const cleaned = Object.fromEntries(
                  Object.entries(choice).filter(([, v]) => v),
                );
                void rpc("environmentSelect", { ref: target, choice: cleaned })
                  .then(() => load(true))
                  .catch((e) => setFailure(String(e)));
              }}
            >
              保存执行选择
            </button>
          </details>
          <section>
            <h3>实际工具与环境</h3>
            <button
              onClick={() =>
                void run("inventory", {
                  endpoint: target.endpoint,
                  cwd: target.path,
                  ecosystem,
                  refresh: true,
                })
              }
            >
              查询当前生态工具版本
            </button>
            {inventory?.value && (
              <>
                <p>{new Date(inventory.stamp).toLocaleString()}</p>
                {inventory.value.tools.map((t: any) => (
                  <details key={t.name + t.path}>
                    <summary>
                      {t.name} ·{" "}
                      {t.output?.trim().split("\n")[0] ?? t.error ?? "项目工具"}
                    </summary>
                    {link(t.path)}
                    <pre>{JSON.stringify(t.argv)}</pre>
                    <pre>{t.output}</pre>
                  </details>
                ))}
              </>
            )}
          </section>
          <section>
            <h3>操作与命令预览</h3>
            <p>
              {target.endpoint} · {target.path}
            </p>
            <label>
              管理器
              <select
                value={manager}
                disabled={ecosystem !== "node"}
                onChange={(e) => {
                  setManagerOverride(e.target.value);
                  setPlan(undefined);
                }}
              >
                {(ecosystem === "node"
                  ? ["npm", "pnpm", "bun"]
                  : [manager]
                ).map((m: string) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              操作
              <select
                value={selectedAction}
                onChange={(e) => {
                  setAction(e.target.value);
                  setPackages("");
                  setPlan(undefined);
                }}
              >
                {availableActions.map((a) => (
                  <option key={a} value={a}>
                    {labels[a] ?? a}
                  </option>
                ))}
              </select>
            </label>
            {/[a-z]-(add|remove|update)$|^(install|uninstall|update)$/.test(
              selectedAction,
            ) && (
              <label>
                包或工具
                <input
                  value={packages}
                  placeholder="空格分隔"
                  onChange={(e) => {
                    setPackages(e.target.value);
                    setPlan(undefined);
                  }}
                />
              </label>
            )}
            <button onClick={() => void preview()}>预览实际命令</button>
            {plan && (
              <div className="command-preview">
                <p>{plan.source}</p>
                <pre>
                  {JSON.stringify(
                    {
                      argv: plan.argv,
                      env: plan.env,
                      runtime: plan.runtime,
                      cwd: plan.cwd,
                    },
                    null,
                    2,
                  )}
                </pre>
                <button
                  onClick={() => {
                    setPlan(undefined);
                    void run("package", plannedInput);
                  }}
                >
                  {plan.mutating ? "确认执行修改" : "执行查询"}
                </button>
              </div>
            )}
          </section>
          <section>
            <h3>项目占用</h3>
            <button onClick={() => void run("size", { ref: target })}>
              统计当前项目
            </button>
            {usage && (
              <p>
                {usage.files ?? 0} 个文件 ·{" "}
                {((usage.bytes ?? 0) / 1048576).toFixed(1)} MiB
              </p>
            )}
          </section>
          {job && (
            <section role="status">
              <h3>任务 · {job.state}</h3>
              <p>{job.progress ?? job.error}</p>
              {["running", "queued"].includes(job.state) && (
                <button
                  onClick={() =>
                    void rpc("jobControl", {
                      id: job.id,
                      action: "cancel",
                    }).catch((e) => setFailure(String(e)))
                  }
                >
                  取消任务
                </button>
              )}
              <pre>{job.logs?.join("\n")}</pre>
              {job.logs
                ?.filter(
                  (line: string) =>
                    /^(\/|[A-Za-z]:[\\])/.test(line.trim()) &&
                    !line.trim().includes("\n"),
                )
                .map((line: string) => (
                  <div key={line}>
                    {link(line.trim())}
                    <button
                      onClick={() =>
                        void run("size", {
                          ref: { ...target, path: line.trim() },
                        })
                      }
                    >
                      统计占用
                    </button>
                  </div>
                ))}
              {job.result && (
                <details>
                  <summary>任务结果与输出</summary>
                  <pre>{JSON.stringify(job.result, null, 2)}</pre>
                </details>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
