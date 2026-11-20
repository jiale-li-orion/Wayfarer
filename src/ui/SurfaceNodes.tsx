import React, { createContext, useContext, useSyncExternalStore } from "react";
import { Handle, Position } from "@xyflow/react";
import { MachineTile, RunTile, type Pick } from "./SurfaceCards";
import { SurfaceLive, runStatus, type Machine, type Run } from "./surfaceLive";
export const SurfaceContext = createContext<{
  live: SurfaceLive;
  pair: string[];
  pick: (p: Pick) => void;
  pairMachine: (id: string) => void;
  openProject: (p: import("../shared/types").Ref) => void;
  openRun: (id: string) => void;
  toggleArchive: (key: string) => void;
}>(null!);
export function SurfaceNode({
  id,
  data,
}: {
  id: string;
  data: {
    kind: string;
    label: string;
    owner?: string;
    projectLocation?: import("../shared/types").Ref;
  };
}) {
  const ctx = useContext(SurfaceContext);
  const value = useSyncExternalStore(
    (fn) => ctx.live.subscribe(id, fn),
    () => ctx.live.get(id),
  );
  let tile;
  if (data.kind === "machine" && value) {
    const m = value as Machine;
    tile = (
      <MachineTile
        m={m}
        mount={m.mount}
        pick={ctx.pick}
        pairing={ctx.pair.includes(m.endpoint)}
        togglePair={() => ctx.pairMachine(m.endpoint)}
      />
    );
  } else if (data.kind === "run" && value) {
    const r = value as Run;
    tile = (
      <RunTile
        name={r.name}
        phase={runStatus(r)}
        step={r.step}
        updated={r.step!=null||r.phase?r.progressAt:undefined}
        attention={r.state === "failed" || r.connection === "offline"}
        open={() => ctx.openRun(r.runId)}
        details={() => ctx.pick({ kind: "run", id: r.runId })}
      />
    );
  } else if (data.kind === "project" && data.projectLocation)
    tile = (
      <button
        className="project-tile nodrag nopan"
        title={data.projectLocation.path}
        onClick={() => ctx.openProject(data.projectLocation!)}
      >
        <i className="codicon codicon-project" /> {data.label}
      </button>
    );
  else if (data.kind === "archive")
    tile = (
      <button
        className="archive-tile nodrag nopan"
        onClick={() => ctx.toggleArchive(data.owner!)}
      >
        {data.label}
      </button>
    );
  return (
    <>
      <Handle type="target" position={Position.Left} />
      {tile}
      <Handle type="source" position={Position.Right} />
    </>
  );
}
