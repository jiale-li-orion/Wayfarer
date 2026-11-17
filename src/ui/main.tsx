import { trimBranches } from "./branchCache";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
  useStore,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@vscode/codicons/dist/codicon.css";
import "./style.css";
import { OverviewCanvas } from "./OverviewCanvas";
import { fieldsFor } from "../packages/catalog";
import type {
  EndpointConfig,
  Entry,
  Job,
  Page,
  Ref,
  ViewState,
} from "../shared/types";
import { defaultView, refKey } from "../shared/types";
import {
  pathSegments,
  parentPath,
  breadcrumbsFor,
} from "../shared/displayPaths";
declare const acquireVsCodeApi: () => {
  postMessage: (m: any) => void;
  setState: (state: unknown) => void;
};
const vscode = acquireVsCodeApi();
vscode.setState({ version: 1 });
const pageId = crypto.randomUUID();
let seq = 0;
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
const listeners = new Set<(v: any) => void>();
function rpc<T = any>(method: string, args: any = {}): Promise<T> {
  const id = pageId + ":" + ++seq;
  vscode.postMessage({ id, method, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(Error(m.error));
    else p?.resolve(m.result);
  } else for (const l of listeners) l(m);
});
const Icon = ({ name }: { name: string }) => (
  <i aria-hidden="true" className={"codicon codicon-" + name} />
);
const iconFor = (kind: string) =>
  ({
    directory: "folder",
    file: "file",
    symlink: "link",
    special: "symbol-misc",
    denied: "lock",
    endpoint: "server",
    more: "ellipsis",
  })[kind] ?? "file";
type Data = Record<string, unknown> & {
  label: string;
  ref?: Ref;
  entry?: Entry;
  kind: string;
  expanded?: boolean;
  error?: string;
  cached?: boolean;
  stamp?: number;
  agent?: boolean;
  onExpand: (ref: Ref) => void;
  onMore?: (key: string) => void;
  onDrop: (target: Ref, refs: Ref[]) => void;
  selection: () => Ref[];
};
type MapNode = Node<Data>;
const FileNode = memo(function FileNode({
  data,
  selected,
}: NodeProps<MapNode>) {
  const [over, setOver] = useState(false);
  const directory = data.kind === "directory" || data.kind === "endpoint";
  const drag = (e: React.DragEvent) => {
    e.stopPropagation();
    const selection = data.selection();
    const refs =
      selected && selection.length ? selection : data.ref ? [data.ref] : [];
    e.dataTransfer.setData("application/workspace-map", JSON.stringify(refs));
    e.dataTransfer.effectAllowed = "copyMove";
  };
  return (
    <div
      className={
        "file-node nopan " +
        (selected ? "selected " : "") +
        (over ? "drop " : "") +
        (data.agent ? "agent " : "")
      }
      onDragOver={(e) => {
        if (
          directory &&
          e.dataTransfer.types.includes("application/workspace-map")
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const raw = e.dataTransfer.getData("application/workspace-map");
        if (raw && data.ref) data.onDrop(data.ref, JSON.parse(raw));
      }}
    >
      <Handle type="target" position={Position.Left} />
      {directory ? (
        <button
          className="expand nodrag nopan"
          aria-label={data.expanded ? "收起" : "展开"}
          onClick={(e) => {
            e.stopPropagation();
            if (data.ref) data.onExpand(data.ref);
          }}
        >
          <Icon name={data.expanded ? "chevron-down" : "chevron-right"} />
        </button>
      ) : (
        <span className="expand">
          <Icon name={iconFor(data.kind)} />
        </span>
      )}
      {data.kind === "more" ? (
        <button
          className="node-label nodrag"
          onClick={() => data.onMore?.(data.label)}
        >
          继续加载
        </button>
      ) : (
        <div
          className="node-label"
          title={
            (data.ref?.path ?? "") +
            ((data.error ?? data.entry?.error)
              ? "\n" + (data.error ?? data.entry?.error)
              : "")
          }
        >
          <strong>{data.label}</strong>
          <span>
            {data.error
              ? "读取失败"
              : data.entry?.target
                ? "→ " + data.entry.target
                : data.kind === "endpoint"
                  ? data.ref?.path
                  : data.entry?.tags?.join(" · ") || ""}
          </span>
        </div>
      )}
      {data.agent && <span className="agent-dot" title="Agent 关注位置" />}
      {data.cached && (
        <span
          className="cached"
          title={"缓存 " + new Date(data.stamp ?? 0).toLocaleTimeString()}
        >
          <Icon name="history" />
        </span>
      )}
      {data.ref && data.kind !== "endpoint" && (
        <button
          className="move-handle nodrag nopan"
          draggable
          onDragStart={drag}
          aria-label="拖拽移动文件"
          title="拖拽移动文件"
        >
          <Icon name="gripper" />
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
const nodeTypes = { file: FileNode };
function App() {
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([]);
  const [view, setView] = useState<ViewState>(defaultView);
  const [branches, setBranches] = useState<Record<string, Page>>({});
  const branchesRef = useRef(branches);
  branchesRef.current = branches;
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<Ref[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [jobsOpen, setJobsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchJob, setSearchJob] = useState<string>();
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [transfer, setTransfer] = useState<{
    sources: Ref[];
    target: Ref;
  } | null>(null);
  const [mode, setMode] = useState<"copy" | "move">("move");
  const [conflict, setConflict] = useState("rename");
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [packageOpen, setPackageOpen] = useState(false);
  const [caps, setCaps] = useState<Record<string, string[]>>({});
  const [pkg, setPkg] = useState({
    manager: "uv",
    action: "list",
    packages: "",
    python: "",
    executable: "",
    source: "",
    channel: "",
    entry: "",
    cacheRoot: "",
  });
  const [pkgPlan, setPkgPlan] = useState<any>();
  const [pkgDetected, setPkgDetected] = useState<any[]>([]);
  const flow = useReactFlow<MapNode>();
  const overview = useStore((s) => s.transform[2] < 0.3);
  const renderNodes = useMemo(
    () => (overview ? nodes.map((n) => ({ ...n, hidden: true })) : nodes),
    [overview, nodes],
  );
  const renderEdges = useMemo(() => (overview ? [] : edges), [overview, edges]);
  const viewRef = useRef(view);
  const selectionRef = useRef(selected);
  const loadPending = useRef(new Set<string>());
  const worker = useRef<Worker | null>(null);
  const layoutId = useRef(0);
  const requestedFocus = useRef(true);
  const layoutAnchor = useRef<{
    id: string;
    position: { x: number; y: number };
  } | null>(null);
  const dataRef = useRef<Map<string, Data>>(new Map());
  const structureRef = useRef("");
  viewRef.current = view;
  selectionRef.current = selected;
  const safe = useCallback(
    (p: Promise<any>) =>
      p.catch((e) => {
        setError(String(e.message ?? e));
      }),
    [],
  );
  const load = useCallback(
    async (ref: Ref, refresh = false, cursor?: string) => {
      const key = refKey(ref);
      if (loadPending.current.has(key)) return;
      loadPending.current.add(key);
      try {
        const p = await rpc<Page>("list", { ref, cursor, refresh });
        setBranches((prev) => {
          if (p.error && prev[key])
            return {
              ...prev,
              [key]: { ...prev[key], cached: true, error: p.error },
            };
          const next = {
            ...prev,
            [key]: cursor
              ? { ...p, entries: [...(prev[key]?.entries ?? []), ...p.entries] }
              : p,
          };
          return trimBranches(next, key, dataRef.current);
        });
      } catch (e) {
        setBranches((prev) =>
          trimBranches(
            {
              ...prev,
              [key]: {
                entries: prev[key]?.entries ?? [],
                stamp: Date.now(),
                error: String(e),
              },
            },
            key,
            dataRef.current,
          ),
        );
      } finally {
        loadPending.current.delete(key);
      }
    },
    [],
  );
  const expand = useCallback(
    (ref: Ref) => {
      const key = refKey(ref);
      const anchor = flow.getNode(key);
      if (anchor) layoutAnchor.current = { id: key, position: anchor.position };
      setView((old) => {
        const expanded = old.expanded.includes(key)
          ? old.expanded.filter((k) => k !== key)
          : [...old.expanded, key];
        void rpc("setView", { expanded });
        return { ...old, expanded };
      });
      void load(ref);
    },
    [load, flow],
  );
  const navigate = useCallback(
    (ref?: Ref) => {
      requestedFocus.current = true;
      void safe(rpc("navigate", { ref }));
    },
    [safe],
  );
  const onDrop = useCallback((target: Ref, sources: Ref[]) => {
    setTransfer({ target, sources });
    setMode("move");
  }, []);
  const selection = useCallback(() => selectionRef.current, []);
  const more = useCallback(
    (key: string) => {
      const [endpoint, path] = JSON.parse(key);
      setBranches((prev) => {
        const p = prev[key];
        if (p?.cursor) void load({ endpoint, path }, false, p.cursor);
        return prev;
      });
    },
    [load],
  );
  useEffect(() => {
    let disposed = false;
    let w: Worker | undefined;
    let blobUrl: string | undefined;
    void fetch((window as any).layoutUri)
      .then((r) => r.text())
      .then((source) => {
        if (disposed) return;
        blobUrl = URL.createObjectURL(
          new Blob([source], { type: "text/javascript" }),
        );
        w = new Worker(blobUrl);
        worker.current = w;
        w.onmessage = (e) => {
          const { id, positions, ms, error, nodes: count } = e.data;
          if (id !== layoutId.current) return;
          if (error) {
            setError(error);
            return;
          }
          setNodes((old) => {
            const previous = new Map(old.map((n) => [n.id, n]));
            return positions.map((p: any) => {
              const prior = previous.get(p.id);
              const data = dataRef.current.get(p.id)!;
              return prior &&
                prior.position.x === p.x &&
                prior.position.y === p.y &&
                prior.data === data
                ? prior
                : {
                    ...prior,
                    id: p.id,
                    type: "file",
                    position: { x: p.x, y: p.y },
                    data,
                    draggable: false,
                    width: 258,
                    height: 50,
                  };
            });
          });
          void rpc("profile", {
            stage: "ui.layout",
            fields: { ms, nodes: count },
          });
          if (requestedFocus.current) {
            requestedFocus.current = false;
            requestAnimationFrame(() => {
              if (viewRef.current.root) {
                const p = positions.find(
                  (n: any) => n.id === refKey(viewRef.current.root!),
                );
                if (p)
                  void flow.setViewport({
                    x: 50 - p.x,
                    y: window.innerHeight / 2 - p.y,
                    zoom: 1,
                  });
              } else
                void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 0 });
            });
          } else if (layoutAnchor.current) {
            const anchor = layoutAnchor.current;
            const pos = positions.find((n: any) => n.id === anchor.id);
            if (pos) {
              const v = flow.getViewport();
              void flow.setViewport({
                ...v,
                x: v.x + (anchor.position.x - pos.x) * v.zoom,
                y: v.y + (anchor.position.y - pos.y) * v.zoom,
              });
            }
          }
          layoutAnchor.current = null;
        };
        if (dataRef.current.size) {
          structureRef.current = "";
          setEndpoints((e) => [...e]);
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      w?.terminate();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [flow]);
  useEffect(() => {
    const listen = (m: any) => {
      if (m.type === "view") {
        setView(m.view);
        if (m.focus) requestedFocus.current = true;
      }
      if (m.type === "endpoints") setEndpoints(m.endpoints);
      if (
        m.type === "branch" &&
        (viewRef.current.expanded.includes(refKey(m.ref)) ||
          (viewRef.current.root &&
            refKey(viewRef.current.root) === refKey(m.ref)))
      )
        void load(m.ref, true);
      if (m.type === "job")
        setJobs((old) =>
          [m.job, ...old.filter((j) => j.id !== m.job.id)].slice(0, 100),
        );
      if (m.type === "search")
        setSearchResults((old) => [...old, ...m.entries].slice(0, 10000));
      if (m.type === "offline")
        setBranches((old) => {
          const k = refKey(m.ref);
          if (!old[k]) return old;
          return { ...old, [k]: { ...old[k], cached: true, error: m.error } };
        });
    };
    listeners.add(listen);
    void rpc("bootstrap")
      .then((b) => {
        setEndpoints(b.endpoints);
        setView(b.view);
        setJobs(b.jobs);
        if (b.restored) requestedFocus.current = false;
        setCaps(b.capabilities);
        void flow.setViewport(b.view.viewport);
      })
      .catch((e) => setError(String(e)));
    return () => {
      listeners.delete(listen);
    };
  }, [load, flow]);
  useEffect(() => {
    const refs = view.root
      ? [view.root]
      : endpoints.map((e) => ({ endpoint: e.id, path: e.root }));
    for (const r of refs) void load(r, true);
  }, [endpoints, view.root, load]);
  useEffect(() => {
    const items: { id: string; parent?: string }[] = [];
    const next = new Map<string, Data>();
    const es: Edge[] = [];
    const expanded = new Set(view.expanded);
    const old = dataRef.current;
    function add(
      ref: Ref,
      entry: Entry | undefined,
      parent?: string,
      root = false,
      ancestry: Set<string> = new Set(),
    ) {
      const id = refKey(ref);
      if (next.has(id)) return;
      const endpoint = endpoints.find((e) => e.id === ref.endpoint);
      if (!endpoint) return;
      const isOpen =
        expanded.has(id) || !!(view.root && refKey(view.root) === id);
      const page = branches[id];
      const isAgent = view.agent && refKey(view.agent) === id;
      const data: Data = {
        label:
          entry?.name ??
          (ref.path === endpoint.root
            ? endpoint.name
            : (pathSegments(ref.path, endpoint.kind === "windows").at(-1) ??
              endpoint.name)),
        ref,
        entry,
        kind: entry?.kind ?? "endpoint",
        expanded: isOpen,
        error: page?.error,
        cached: page?.cached,
        stamp: page?.stamp,
        agent: !!isAgent,
        onExpand: expand,
        onMore: more,
        onDrop,
        selection,
      };
      const prior = old.get(id);
      next.set(
        id,
        prior && Object.keys(data).every((k) => prior[k] === data[k])
          ? prior
          : data,
      );
      items.push({ id, parent });
      if (parent)
        es.push({
          id: parent + ">" + id,
          source: parent,
          target: id,
          type: "smoothstep",
          selectable: false,
        });
      if (!isOpen) return;
      if (!page) {
        void load(ref);
        return;
      }
      const identity = ref.endpoint + ":" + (entry?.resolved ?? ref.path);
      if (ancestry.has(identity)) return;
      const visited = new Set(ancestry);
      visited.add(identity);
      for (const child of page.entries)
        add(
          { endpoint: ref.endpoint, path: child.path },
          child,
          id,
          false,
          visited,
        );
      if (
        view.agent &&
        view.agentEntry &&
        view.agent.endpoint === ref.endpoint
      ) {
        const parent = view.agent.path.replace(/[\\\\/][^\\\\/]+$/, "") || "/";
        if (
          parent === ref.path &&
          !page.entries.some((e) => e.path === view.agent!.path)
        )
          add(view.agent, view.agentEntry, id, false, visited);
      }
      if (page.cursor) {
        const mid = id + ":more";
        next.set(mid, {
          label: id,
          kind: "more",
          onExpand: expand,
          onMore: more,
          onDrop,
          selection,
        });
        items.push({ id: mid, parent: id });
        es.push({
          id: id + ">" + mid,
          source: id,
          target: mid,
          selectable: false,
        });
      }
    }
    if (view.root) {
      const key = refKey(view.root);
      let entry: Entry | undefined;
      for (const [key, b] of Object.entries(branches)) {
        if (JSON.parse(key)[0] !== view.root.endpoint) continue;
        entry = b.entries.find((e) => e.path === view.root!.path);
        if (entry) break;
      }
      add(view.root, entry, undefined, true);
    } else
      for (const e of endpoints)
        add({ endpoint: e.id, path: e.root }, undefined, undefined, true);
    dataRef.current = next;
    const watched = [...next.values()]
      .filter((d) => d.ref && d.expanded)
      .map((d) => d.ref!);
    void rpc("watch", { refs: watched });
    const signature = items.map((x) => x.id + "|" + x.parent).join("\n");
    if (signature !== structureRef.current && worker.current) {
      structureRef.current = signature;
      setEdges(es);
      worker.current.postMessage({ id: ++layoutId.current, items });
    } else
      setNodes((old) =>
        old.map((n) =>
          next.has(n.id) && n.data !== next.get(n.id)
            ? { ...n, data: next.get(n.id)! }
            : n,
        ),
      );
  }, [
    endpoints,
    branches,
    view.root,
    view.expanded,
    view.agent,
    expand,
    more,
    onDrop,
    selection,
    load,
  ]);
  useEffect(() => {
    let longTasks = 0;
    let longMs = 0;
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          longTasks++;
          longMs += e.duration;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {}
    const timer = setInterval(() => {
      if (document.hidden) return;
      const memory = (performance as any).memory;
      void rpc("profile", {
        stage: "ui.resources",
        fields: {
          heapBytes: memory?.usedJSHeapSize,
          heapLimit: memory?.jsHeapSizeLimit,
          nodes: dataRef.current.size,
          cachedBranches: Object.keys(branchesRef.current).length,
          cachedEntries: Object.values(branchesRef.current).reduce(
            (n, page) => n + page.entries.length,
            0,
          ),
          longTasks,
          longTaskMs: longMs,
        },
      });
      longTasks = 0;
      longMs = 0;
    }, 15000);
    return () => {
      clearInterval(timer);
      observer?.disconnect();
    };
  }, []);
  const selectionPath = selected[0] ?? view.root;
  const selectedKind = selectionPath
    ? dataRef.current.get(refKey(selectionPath))?.kind
    : undefined;
  const workDirectory =
    selectionPath &&
    selectedKind &&
    !["directory", "endpoint"].includes(selectedKind)
      ? {
          ...selectionPath,
          path: parentPath(
            selectionPath.path,
            endpoints.find((e) => e.id === selectionPath.endpoint)?.kind ===
              "windows",
          ),
        }
      : selectionPath;
  const selectionChange = useCallback(
    ({ nodes }: { nodes: MapNode[] }) =>
      setSelected(nodes.flatMap((n) => (n.data.ref ? [n.data.ref] : []))),
    [],
  );
  const busy = jobs.filter((j) =>
    ["running", "queued"].includes(j.state),
  ).length;
  const act = (method: string, args: any) =>
    safe(rpc(method, args).then(() => setJobsOpen(true)));
  const command = (name: string) => safe(rpc("command", { name }));
  const context = (action: string) => {
    if (!selectionPath) return;
    void safe(
      rpc("promptAction", {
        action,
        refs:
          action === "create" && workDirectory
            ? [workDirectory]
            : selected.length
              ? selected
              : [selectionPath],
      }),
    );
  };
  const runSearch = async () => {
    const ref =
      workDirectory ??
      (endpoints[0]
        ? { endpoint: endpoints[0].id, path: endpoints[0].root }
        : undefined);
    if (!ref) return;
    setSearchResults([]);
    const j = await rpc("search", { ref, query });
    setSearchJob(j.id);
  };
  const packageInput = () => {
    const input: any = {
      endpoint: workDirectory?.endpoint,
      cwd: workDirectory?.path,
      manager: pkg.manager,
      action: pkg.action,
    };
    for (const key of fieldsFor(pkg.manager, pkg.action)) {
      if (key === "packages")
        input.packages = pkg.packages.trim()
          ? pkg.packages.trim().split(/\s+/)
          : [];
      else if (pkg[key]) input[key] = pkg[key];
    }
    return input;
  };
  const titlePath = useMemo(() => view.root?.path ?? "全部端点", [view.root]);
  const breadcrumbs = useMemo(
    () =>
      view.root
        ? breadcrumbsFor(
            view.root.path,
            endpoints.find((e) => e.id === view.root!.endpoint)?.kind ===
              "windows",
          )
        : [],
    [view.root, endpoints],
  );
  return (
    <main
      onPointerDownCapture={(event) => {
        if (
          viewRef.current.follow &&
          !(event.target as Element).closest("[data-follow-toggle]")
        ) {
          setView((v) => ({ ...v, follow: false }));
          void rpc("setView", { manual: true });
        }
      }}
    >
      <ReactFlow<MapNode>
        nodes={renderNodes}
        edges={renderEdges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) =>
          setNodes((ns) => applyNodeChanges(changes, ns))
        }
        onSelectionChange={selectionChange}
        onlyRenderVisibleElements
        nodesDraggable={false}
        zoomOnDoubleClick={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.005}
        maxZoom={2.5}
        multiSelectionKeyCode="Control"
        selectionKeyCode="Shift"
        onNodeDoubleClick={(_, n) => {
          if (!n.data.ref) return;
          if (n.data.kind === "directory" || n.data.kind === "endpoint")
            navigate(n.data.ref);
          else if (
            n.data.kind === "symlink" &&
            n.data.entry?.targetKind === "directory"
          )
            navigate({
              endpoint: n.data.ref.endpoint,
              path: n.data.entry.resolved!,
            });
          else void safe(rpc("open", { ref: n.data.ref }));
        }}
        onMoveStart={(event) => {
          if (event && viewRef.current.follow) {
            setView((v) => ({ ...v, follow: false }));
            void rpc("setView", { manual: true });
          }
        }}
        onMoveEnd={(_, viewport) => void rpc("setView", { viewport })}
        onPaneClick={() => setError("")}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={28} size={1} />
        {overview && <OverviewCanvas nodes={nodes} edges={edges} />}
        <Controls
          position="bottom-left"
          showInteractive={false}
          fitViewOptions={{ includeHiddenNodes: true }}
        />
      </ReactFlow>
      <nav className="toolbar top" aria-label="地图导航">
        <button
          onClick={() => safe(rpc("history", { direction: -1 }))}
          title="返回"
        >
          <Icon name="arrow-left" />
        </button>
        <button
          onClick={() => safe(rpc("history", { direction: 1 }))}
          title="前进"
        >
          <Icon name="arrow-right" />
        </button>
        <button onClick={() => navigate()} title="全部端点">
          <Icon name="home" />
        </button>
        <button
          title="刷新当前目录"
          onClick={() => {
            const targets = view.root
              ? [view.root]
              : endpoints.map((e) => ({ endpoint: e.id, path: e.root }));
            for (const ref of targets) void load(ref, true);
          }}
        >
          <Icon name="refresh" />
        </button>
        <span className="divider" />
        {view.root ? (
          <div className="breadcrumb-parts">
            {breadcrumbs.map((b) => (
              <button
                key={b.path}
                title={b.path}
                onClick={() =>
                  navigate({ endpoint: view.root!.endpoint, path: b.path })
                }
              >
                {b.label}
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        ) : (
          <span className="breadcrumb">全部端点</span>
        )}
        <button
          title="输入路径定位"
          onClick={() =>
            safe(rpc("promptAction", { action: "locate", refs: [] }))
          }
        >
          <Icon name="go-to-file" />
        </button>
        <button
          title="上一级"
          disabled={!view.root}
          onClick={() => safe(rpc("parent", { ref: view.root }).then(navigate))}
        >
          <Icon name="arrow-up" />
        </button>
        <button
          title="定位全部已加载节点"
          onClick={() =>
            flow.fitView({
              duration: 0,
              padding: 0.2,
              maxZoom: 1,
              includeHiddenNodes: true,
            })
          }
        >
          <Icon name="screen-full" />
        </button>
        <button title="搜索当前子树" onClick={() => setSearchOpen((v) => !v)}>
          <Icon name="search" />
        </button>
        <button title="书签" onClick={() => setBookmarksOpen((v) => !v)}>
          <Icon name="bookmark" />
        </button>
      </nav>
      <div className="toolbar top-right">
        <button
          title={
            view.agent
              ? view.agent.endpoint + ": " + view.agent.path
              : "Agent 尚未定位"
          }
          data-follow-toggle
          className={view.follow ? "active" : ""}
          onClick={() => {
            const follow = !view.follow;
            setView((v) => ({ ...v, follow }));
            void rpc("setView", { follow });
          }}
        >
          <Icon name="hubot" />
          跟随 Agent {view.follow ? "开" : "关"}
        </button>
        <button onClick={() => setJobsOpen((v) => !v)}>
          <Icon name="tasklist" />
          任务{busy > 0 ? " " + busy : ""}
        </button>
        <button title="连接和接入" onClick={() => command("connections")}>
          <Icon name="plug" />
        </button>
      </div>
      {selected.length > 0 && (
        <div className="toolbar selection">
          <span>
            {selected.length === 1 ? selected[0].path : selected.length + " 项"}
          </span>
          <button onClick={() => context("open")} title="打开">
            <Icon name="go-to-file" />
          </button>
          <button onClick={() => context("create")} title="新建">
            <Icon name="new-file" />
          </button>
          <button onClick={() => context("rename")} title="重命名">
            <Icon name="edit" />
          </button>
          <button onClick={() => context("copy")} title="复制到">
            <Icon name="copy" />
          </button>
          <button onClick={() => context("move")} title="移动到">
            <Icon name="move" />
          </button>
          <button onClick={() => context("delete")} title="删除">
            <Icon name="trash" />
          </button>
          <button
            onClick={() => act("size", { ref: selected[0] })}
            title="统计大小"
          >
            <Icon name="dashboard" />
          </button>
          <button onClick={() => setPackageOpen(true)} title="包管理">
            <Icon name="package" />
          </button>
          <button
            onClick={() => {
              const bookmarks = [
                ...view.bookmarks.filter(
                  (b) => refKey(b) !== refKey(selected[0]),
                ),
                selected[0],
              ];
              setView((v) => ({ ...v, bookmarks }));
              void rpc("setView", { bookmarks });
            }}
            title="添加书签"
          >
            <Icon name="bookmark" />
          </button>
        </div>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
      )}
      {bookmarksOpen && (
        <section className="floating bookmarks">
          <h2>
            书签
            <button onClick={() => setBookmarksOpen(false)}>
              <Icon name="close" />
            </button>
          </h2>
          {view.bookmarks.length === 0 ? (
            <p>选择目录后添加书签</p>
          ) : (
            view.bookmarks.map((b) => (
              <div className="bookmark-row" key={refKey(b)}>
                <button
                  onClick={() => {
                    navigate(b);
                    setBookmarksOpen(false);
                  }}
                >
                  {b.endpoint} · {b.path}
                </button>
                <button
                  title="移除书签"
                  onClick={() => {
                    const bookmarks = view.bookmarks.filter(
                      (x) => refKey(x) !== refKey(b),
                    );
                    setView((v) => ({ ...v, bookmarks }));
                    void rpc("setView", { bookmarks });
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))
          )}
        </section>
      )}
      {searchOpen && (
        <section className="floating search">
          <h2>
            搜索当前子树
            <button onClick={() => setSearchOpen(false)}>
              <Icon name="close" />
            </button>
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void safe(runSearch());
            }}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="文件或目录名称"
            />
            <button type="submit">搜索</button>
            {searchJob && (
              <button
                type="button"
                onClick={() =>
                  act("jobControl", { id: searchJob, action: "cancel" })
                }
              >
                停止
              </button>
            )}
          </form>
          <div className="results">
            {searchResults.slice(-300).map((r) => (
              <button
                key={r.endpoint + r.path}
                onClick={() =>
                  r.kind === "directory"
                    ? navigate({ endpoint: r.endpoint, path: r.path })
                    : safe(
                        rpc("open", {
                          ref: { endpoint: r.endpoint, path: r.path },
                        }),
                      )
                }
              >
                <Icon name={iconFor(r.kind)} />
                {r.path}
              </button>
            ))}
          </div>
          <p>{searchResults.length} 项 · 显示最近 300 项</p>
        </section>
      )}
      {jobsOpen && (
        <section className="floating jobs">
          <h2>
            后台任务
            <button title="性能日志" onClick={() => command("logs")}>
              <Icon name="output" />
            </button>
            <button onClick={() => setJobsOpen(false)}>
              <Icon name="close" />
            </button>
          </h2>
          <div className="job-list">
            {jobs.length === 0 ? (
              <p>暂无任务</p>
            ) : (
              jobs.map((j) => (
                <article key={j.id}>
                  <div className="job-title">
                    <strong>{j.kind}</strong>
                    <span>{j.state}</span>
                  </div>
                  <p>{j.progress ?? j.id}</p>
                  <p>
                    {j.files} 项 · {(j.bytes / 1048576).toFixed(1)} MiB
                  </p>
                  {j.error && <p className="failure">{j.error}</p>}
                  <div className="actions">
                    {["running", "queued"].includes(j.state) &&
                      j.kind !== "package" && (
                        <button
                          onClick={() =>
                            act("jobControl", { id: j.id, action: "pause" })
                          }
                        >
                          暂停
                        </button>
                      )}
                    {["paused", "failed"].includes(j.state) && (
                      <button
                        onClick={() =>
                          act("jobControl", { id: j.id, action: "resume" })
                        }
                      >
                        继续
                      </button>
                    )}
                    {!["completed", "cancelled"].includes(j.state) && (
                      <button
                        onClick={() =>
                          act("jobControl", { id: j.id, action: "cancel" })
                        }
                      >
                        取消
                      </button>
                    )}
                    <button
                      onClick={() => safe(rpc("jobDetails", { id: j.id }))}
                    >
                      详情与日志
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      )}
      {transfer && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="文件传输"
          >
            <h2>
              文件传输
              <button onClick={() => setTransfer(null)}>
                <Icon name="close" />
              </button>
            </h2>
            <label>
              源
              <pre>
                {transfer.sources
                  .map((r) => r.endpoint + ": " + r.path)
                  .join("\n")}
              </pre>
            </label>
            <label>
              目标
              <pre>
                {transfer.target.endpoint}: {transfer.target.path}
              </pre>
            </label>
            <div className="form-row">
              <label>
                操作
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as any)}
                >
                  <option value="move">移动</option>
                  <option value="copy">复制</option>
                </select>
              </label>
              <label>
                同名冲突
                <select
                  value={conflict}
                  onChange={(e) => setConflict(e.target.value)}
                >
                  <option value="rename">保留两份，自动改名</option>
                  <option value="skip">跳过</option>
                  <option value="overwrite">合并目录，覆盖同名文件</option>
                </select>
              </label>
            </div>
            <button
              className="primary"
              onClick={() => {
                void act("transfer", { ...transfer, mode, conflict });
                setTransfer(null);
              }}
            >
              开始{mode === "move" ? "移动" : "复制"}
            </button>
          </section>
        </div>
      )}
      {packageOpen && (
        <div className="modal-backdrop">
          <section
            className="modal package"
            role="dialog"
            aria-modal="true"
            aria-label="包管理"
          >
            <h2>
              包管理
              <button onClick={() => setPackageOpen(false)}>
                <Icon name="close" />
              </button>
            </h2>
            <p>
              {workDirectory?.endpoint} · {workDirectory?.path}
            </p>
            <button
              onClick={() =>
                safe(
                  rpc("packageDiscover", {
                    endpoint: workDirectory?.endpoint,
                    cwd: workDirectory?.path,
                  }).then(setPkgDetected),
                )
              }
            >
              检测可用管理器
            </button>
            {pkgDetected.length > 0 && (
              <pre>
                {pkgDetected.map((m) => m.name + " · " + m.path).join("\n")}
              </pre>
            )}
            <div className="form-row">
              <label>
                管理器
                <select
                  value={pkg.manager}
                  onChange={(e) => {
                    setPkgPlan(undefined);
                    setPkg((p) => ({
                      ...p,
                      manager: e.target.value,
                      action: caps[e.target.value][0],
                      executable: "",
                      python: "",
                      packages: "",
                      source: "",
                      channel: "",
                      entry: "",
                      cacheRoot: "",
                    }));
                  }}
                >
                  {Object.keys(caps).map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label>
                操作
                <select
                  value={pkg.action}
                  onChange={(e) => {
                    setPkgPlan(undefined);
                    setPkg((p) => ({ ...p, action: e.target.value }));
                  }}
                >
                  {(caps[pkg.manager] ?? []).map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
            </div>
            {fieldsFor(pkg.manager, pkg.action).map((k) => (
              <label key={k}>
                {
                  (
                    {
                      packages: "包名 / 工具链（空格分隔）",
                      python: "Python 解释器",
                      executable: "管理器可执行文件",
                      source: "包来源",
                      channel: "Flutter 渠道",
                      entry: "指定缓存条目",
                      cacheRoot: "缓存根目录",
                    } as any
                  )[k]
                }
                <input
                  value={pkg[k]}
                  onChange={(e) => {
                    setPkgPlan(undefined);
                    setPkg((p) => ({ ...p, [k]: e.target.value }));
                  }}
                />
              </label>
            ))}
            <button
              onClick={() =>
                safe(rpc("packagePlan", packageInput()).then(setPkgPlan))
              }
            >
              预览命令
            </button>
            {pkgPlan && (
              <>
                <pre>{JSON.stringify(pkgPlan, null, 2)}</pre>
                <button
                  className="primary"
                  onClick={() => {
                    void act("package", packageInput());
                    setPackageOpen(false);
                  }}
                >
                  执行
                </button>
              </>
            )}
          </section>
        </div>
      )}
      <div className="status">
        <span>{nodes.length} 节点</span>
        <span>拖动画布 · 滚轮缩放 · 双击进入 · 手柄搬移</span>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
