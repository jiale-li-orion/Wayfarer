import React, { useState, useEffect } from "react";
import { rpc } from "./rpc";
import { MachineInspector } from "./MachineInspector";
import { WorkloadPanel } from "./WorkloadPanel";
import { FleetTools } from "./PerformanceViews";
import { capacity, type Pick } from "./SurfaceCards";
import type { Topology } from "./surfaceLive";
export const resourceCall = (method: string, args: any = {}) =>
  rpc("surfaceAction", { method, args });
export const openResource = (view: string, extra: any = {}) =>
  rpc("surfaceReport", { view, ...extra });
function DiskRanks({ endpoint, path }: { endpoint: string; path: string }) {
  const [page, set] = useState<any>(),
    [error, fail] = useState(""),
    [snapshot, id] = useState(""),
    [dir, go] = useState<string>(),
    [job, watch] = useState<string>(),
    [offset, turn] = useState(0),
    [starting, start] = useState(false);
  useEffect(() => {
    let alive = true;
    rpc("storageSnapshots")
      .then((rows) => {
        if (alive)
          id(
            rows.find(
              (r: any) => r.ref?.endpoint === endpoint && r.ref?.path === path,
            )?.id ?? "",
          );
      })
      .catch((e) => alive && fail(String(e)));
    return () => {
      alive = false;
    };
  }, [endpoint, path]);
  useEffect(() => {
    if (!snapshot) return;
    let alive = true;
    rpc("storageResult", { id: snapshot, directory: dir, offset, limit: 30 })
      .then((v) => {
        if (alive) {
          set(v);
          fail("");
        }
      })
      .catch((e) => alive && fail(String(e)));
    return () => {
      alive = false;
    };
  }, [snapshot, dir, offset]);
  useEffect(() => {
    if (!job) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const j = await rpc("job", { id: job, fields: ["summary"] });
        if (!alive) return;
        if (j.state === "completed") {
          id(job!);
          turn(0);
          go(undefined);
          watch(undefined);
        } else if (["failed", "paused", "cancelled"].includes(j.state)) {
          watch(undefined);
          fail(j.error ?? j.state);
        } else timer = setTimeout(check, 1000);
      } catch (e) {
        if (alive) {
          watch(undefined);
          fail(String(e));
        }
      }
    }
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [job]);
  async function scan() {
    start(true);
    try {
      const j = await rpc("storageScan", {
        ref: { endpoint, path },
        operationId: crypto.randomUUID(),
      });
      watch(j.id);
      fail("");
    } catch (e) {
      fail(String(e));
    } finally {
      start(false);
    }
  }
  return (
    <>
      <p>{path}</p>
      {error && <p role="alert">{error}</p>}
      {page?.rows.map((r: any) => (
        <button
          key={r.id}
          className="fact-row"
          onClick={() => {
            go(r.id);
            turn(0);
          }}
        >
          <span>{r.path}</span>
          <b>{capacity(r.allocatedBytesKnown)}</b>
        </button>
      ))}
      {!snapshot && !job && <p>此挂载尚无目录占用快照。</p>}
      {dir && (
        <button
          onClick={() => {
            go(undefined);
            turn(0);
          }}
        >
          回到挂载根目录
        </button>
      )}
      {offset > 0 && <button onClick={() => turn(offset - 30)}>上一页</button>}
      {page?.hasMore && (
        <button onClick={() => turn(offset + 30)}>下一页</button>
      )}
      {job ? (
        <button
          onClick={() =>
            rpc("jobControl", { id: job, action: "cancel" }).catch((e) =>
              fail(String(e)),
            )
          }
        >
          取消统计
        </button>
      ) : (
        <button onClick={scan} disabled={starting}>
          {starting ? "正在启动…" : snapshot ? "重新统计" : "统计此目录"}
        </button>
      )}
      <button
        onClick={() =>
          rpc("storageView", { ref: { endpoint, path } }).catch((e) =>
            fail(String(e)),
          )
        }
      >
        完整存储分析
      </button>
    </>
  );
}
export function SurfaceDrawer({
  target,
  topology,
  catalogMachines,
  filter,
  onFilter,
  onPick,
  close,
}: {
  target: Pick;
  topology: Topology;
  catalogMachines: Topology["machines"];
  filter: string;
  onFilter: (id: string) => void;
  onPick: (p: Pick) => void;
  close: () => void;
}) {
  const m = topology.machines.find(
    (x) =>
      x.endpoint === target.endpoint ||
      x.roots.some((r) => r.endpoint === target.endpoint),
  );
  const name =
    target.kind === "pair"
      ? "双机连接"
      : target.kind === "groups"
        ? "巡检设置"
        : target.kind === "disk"
          ? "目录占用"
          : target.kind === "run" || target.kind === "runs"
            ? "关注的运行"
            : m?.name;
  return (
    <aside className="surface-drawer" aria-label="地图详情">
      <header>
        <h2>{name}</h2>
        <button aria-label="关闭地图详情" onClick={close}>
          ×
        </button>
      </header>
      {target.kind === "run" || target.kind === "runs" ? (
        <WorkloadPanel
          machines={topology.machines}
          runId={target.id}
          call={resourceCall}
          select={(id) => (id ? onPick({ kind: "run", id }) : close())}
          onFile={(f) => {
            void (
              f.kind === "model" || f.kind === "profile"
                ? openResource(f.kind === "model" ? "model" : "runs", {
                    ref: f,
                  })
                : resourceCall("openWorkloadFile", { ref: f })
            ).catch((e) => rpc("surfaceError", { message: String(e) }));
          }}
          onTransfer={(jobId) => void openResource("job", { jobId })}
        />
      ) : target.kind === "pair" || target.kind === "groups" ? (
        <FleetTools
          filter={filter}
          onFilter={onFilter}
          machines={catalogMachines}
          selectedPair={
            target.kind === "pair" ? [target.endpoint!, target.other!] : []
          }
          call={resourceCall}
        />
      ) : target.kind === "disk" && m ? (
        <DiskRanks
          endpoint={
            m.roots.find(
              (r) =>
                m.kind === "windows" &&
                target.path?.toLowerCase().startsWith(r.path.toLowerCase()),
            )?.endpoint ??
            target.endpoint ??
            m.endpoint
          }
          path={target.path ?? m.roots[0].path}
        />
      ) : m ? (
        <MachineInspector
          machine={m}
          pick={target}
          call={resourceCall}
          onRun={(id) => onPick({ kind: "run", id })}
        />
      ) : null}
    </aside>
  );
}
