import { compactResourceSnapshot } from "./resourceExport";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Endpoints } from "../adapters/registry";
import { Directories } from "./directories";
import { EXIT_GRACE_MS } from "./lifecycle";
import { Jobs, type JobContext } from "./jobs";
import { Transfers, type TransferInput } from "./transfer";
import { Profiler } from "./log";
import {
  defaultView,
  refKey,
  type EndpointConfig,
  type Ref,
  type ViewState,
  type Page,
} from "../shared/types";
import { alias, assertName, pathApi } from "../shared/paths";
import { capabilities, recipe } from "../packages/catalog";
import { Inspector } from "./inspect";
import { StorageAnalysis } from "./storage";
import { SystemMonitor } from "./monitor";
import { compareMachines, sameConfirmedShare } from "./fleet";
import { Links } from "./links";
import { modelAnalysis } from "./modelAnalysis";
import { AgentRecords } from "./agentRecords";
import { ProjectRuns } from "./projectRuns";
import { Workloads, type ObserveRuns } from "./workloads";
import { RunProfiles } from "./runProfiles";
import { OperationsStore } from "./operations";
import { PeerTransfer } from "./peerTransfer";
import { runPackage } from "../packages/runner";
export class Core extends EventEmitter {
  agentStats?: () => any;
  workspaceUiStats?: () => any;
  environmentUiStats?: () => any;
  workspaceStore?: import("./workspaces").WorkspaceStore;
  readonly endpoints: Endpoints;
  readonly directories: Directories;
  readonly jobs: Jobs;
  readonly transfers: Transfers;
  readonly inspector: Inspector;
  readonly monitor: SystemMonitor;
  readonly links: Links;
  readonly agentRecords: AgentRecords;
  readonly projectRuns: ProjectRuns;
  readonly workloads: Workloads;
  readonly runProfiles: RunProfiles;
  readonly operations: OperationsStore;
  readonly peer: PeerTransfer;
  readonly storageAnalysis: StorageAnalysis;
  private inventories = new Map<string, string>();
  view = defaultView();
  restored = false;
  private timer?: NodeJS.Timeout;
  private viewWrites = Promise.resolve();
  private navigationRevision = 0;
  private closing?: Promise<void>;
  private recovery = new Map<string, NodeJS.Timeout>();
  private clients = new Set<string>();
  private stage = "running";
  private recover(id: string, delay = 1000) {
    if (this.closing || this.recovery.has(id)) return;
    const timer = setTimeout(async () => {
      this.recovery.delete(id);
      const job = this.jobs.records.get(id);
      if (
        this.closing ||
        job?.state !== "paused" ||
        job.pauseReason !== "network"
      )
        return;
      const refs = [...job.input.sources, job.input.target];
      try {
        for (const endpoint of new Set<string>(
          refs.map((r: Ref) => r.endpoint),
        )) {
          if (!this.endpoints.enabled(endpoint)) return;
          await this.endpoints.get(endpoint).call("info");
        }
        this.jobs.control(id, "resume");
      } catch {
        this.recover(id, Math.min(delay * 2, 30000));
      }
    }, delay);
    timer.unref();
    this.recovery.set(id, timer);
  }
  attachClient(id: string) {
    this.clients.add(id);
    this.directories.attachOwner(id);
  }
  releaseClient(id: string) {
    this.clients.delete(id);
    this.directories.releaseOwner(id);
  }

  constructor(
    readonly storage: string,
    helper: string,
    readonly profile: Profiler,
    options: {
      pageSize?: number;
      transferConcurrency?: number;
      trash?: (p: string) => Promise<void>;
      monitorPython?: string;
      resourceRecordingDirectory?: string;
    } = {},
  ) {
    super();
    this.endpoints = new Endpoints(
      helper,
      (s) => profile.record("endpoint", { message: s }),
      options.trash,
    );
    this.monitor = new SystemMonitor(
      () => this.endpoints.configs(),
      path.join(path.dirname(helper), "monitor.py"),
      storage,
      profile,
      options.monitorPython,
      undefined,
      (id) => this.endpoints.enabled(id),
      {
        directory: options.resourceRecordingDirectory
          ? path.join(
              options.resourceRecordingDirectory,
              path.basename(storage),
              "resource-recordings",
            )
          : undefined,
      },
    );
    this.storageAnalysis = new StorageAnalysis(
      path.join(storage, "storage-scans"),
      path.join(path.dirname(helper), "storage.py"),
      (id) => this.endpoints.get(id).config,
      profile,
      options.monitorPython,
    );
    this.directories = new Directories(
      this.endpoints,
      profile,
      options.pageSize,
    );
    this.jobs = new Jobs(
      path.join(storage, "jobs"),
      profile,
      options.transferConcurrency,
    );
    this.inspector = new Inspector(this.endpoints, storage, profile);
    this.monitor.projects = () => this.inspector.projects();
    this.links = new Links(
      this.endpoints,
      path.join(path.dirname(helper), "link_probe.py"),
    );
    this.workloads = new Workloads(
      path.join(storage, "workloads.json"),
      (ref) =>
        typeof ref.path === "string" &&
        pathApi(this.endpoints.get(ref.endpoint).config).isAbsolute(ref.path),
      (a, b) =>
        this.monitor
          .machines()
          .some(
            (m) =>
              m.roots.some((r) => r.endpoint === a) &&
              m.roots.some((r) => r.endpoint === b),
          ),
    );
    this.agentRecords = new AgentRecords(
      this.monitor,
      this.storageAnalysis,
      this.endpoints,
      storage,
    );
    this.jobs.register("export", (c) => this.agentRecords.export(c));
    this.jobs.registerCleanup("export", (j) => this.agentRecords.cleanup(j));
    this.projectRuns = new ProjectRuns(
      this.endpoints,
      this.workloads,
      (fields) => this.profile.record("run.index", fields),
    );
    this.runProfiles = new RunProfiles(this.endpoints, storage);
    this.jobs.register("linkProbe", (context) => this.links.run(context));
    this.jobs.register("storage", (c) => this.storageAnalysis.run(c));
    this.jobs.register("inventory", (c) => this.inspector.inventory(c));
    this.operations = new OperationsStore(
      path.join(storage, "operations-settings.json"),
      () => this.endpoints.configs(),
    );
    this.peer = new PeerTransfer(
      path.join(path.dirname(helper), "peer_transfer.py"),
    );
    const transfers = (this.transfers = new Transfers(
      this.endpoints,
      (r) => this.invalidateParent(r),
      this.operations,
      this.peer,
      (a, b) => sameConfirmedShare(this.monitor, this.operations, a, b),
    ));
    this.jobs.register("transfer", (c) => transfers.run(c));
    this.jobs.registerCleanup("transfer", (j) => transfers.cleanup(j));
    this.jobs.on("recover", (id) => this.recover(id));
    this.jobs.register("package", async (c) => {
      try {
        return await runPackage(this.endpoints, c);
      } finally {
        this.inspector.invalidate(c.job.input.endpoint);
      }
    });
    this.jobs.register("search", (c) => this.scan(c, "search"));
    this.jobs.register("size", async (c) => {
      const result = await this.scan(c, "size");
      this.inspector.rememberUsage(c.job.input.ref, result);
      return result;
    });
    this.jobs.register("mutation", (c) => this.mutate(c));
    this.jobs.on("change", (j) => {
      if (!["running", "queued"].includes(j.state))
        for (const [key, id] of this.inventories)
          if (id === j.id) this.inventories.delete(key);
      this.emit("event", { type: "job", job: this.jobs.summary(j) });
    });
    this.directories.on("change", (ref) =>
      this.emit("event", { type: "branch", ref }),
    );
    this.directories.on("offline", (e) =>
      this.emit("event", { type: "offline", ...e }),
    );
  }
  async init(configs: EndpointConfig[] = []) {
    await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
    await this.endpoints.discover(configs);
    await this.operations.init();
    await this.workloads.init();
    await this.jobs.init();
    await this.inspector.init();
    try {
      const s = JSON.parse(
        await fs.readFile(path.join(this.storage, "view.json"), "utf8"),
      );
      this.view = { ...defaultView(), ...s.view, follow: false };
      this.restored = true;
      this.directories.restore(s.cache ?? []);
    } catch {}
    this.jobs.resumeInterrupted();
    for (const job of this.jobs.records.values())
      if (job.pauseReason === "network") this.recover(job.id);
  }
  private observeRuns: ObserveRuns = async (endpoint, pids, paths) => {
    const { status, stamp, bootId, identities, reports } =
      await this.monitor.snapshot({
        endpoint,
        section: "identities",
        pids,
        paths,
      });
    return { status, stamp, bootId, identities, reports };
  };
  async surfaceRuns(root?: Ref, allowed?: Set<string>, active = () => true) {
    const config = root && this.endpoints.items.get(root.endpoint)?.config;
    await this.projectRuns.refresh(this.inspector.projects(), allowed);
    if (!active()) return [];
    return this.workloads.surface((row) => {
      if (!root) return !allowed || allowed.has(row.endpoint);
      if (
        row.projectRef &&
        config &&
        row.projectRef.endpoint === root.endpoint
      ) {
        const api = pathApi(config),
          rel = api.relative(root.path, row.projectRef.path);
        const within = (v: string) =>
          !api.isAbsolute(v) && v !== ".." && !v.startsWith(".." + api.sep);
        return (
          within(rel) || within(api.relative(row.projectRef.path, root.path))
        );
      }
      return root.endpoint === row.endpoint && root.path === config?.root;
    }, this.observeRuns);
  }
  private saveView() {
    clearTimeout(this.timer);
    if (this.closing) return;
    this.timer = setTimeout(
      () =>
        void this.persist().catch((error) =>
          this.profile.record("view.write", { error: String(error) }),
        ),
      300,
    );
  }
  private persist(cache = this.directories.snapshot()) {
    const file = path.join(this.storage, "view.json");
    const data = JSON.stringify({ view: this.view, cache });
    return (this.viewWrites = this.viewWrites
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(file + ".tmp", data, { mode: 0o600 });
        await fs.rename(file + ".tmp", file);
      }));
  }
  setModelSelection(value: NonNullable<ViewState["modelSelection"]>) {
    this.view.modelSelection = value;
    this.saveView();
  }
  invalidateParent(r: Ref) {
    this.inspector.invalidate(r.endpoint);
    const c = this.endpoints.get(r.endpoint).config;
    this.directories.invalidate({
      endpoint: r.endpoint,
      path: pathApi(c).dirname(r.path),
    });
  }
  private selectedRoots(refs: Ref[]) {
    const unique = new Map<string, Ref>();
    for (const ref of refs) {
      const key = alias(
        this.endpoints.get(ref.endpoint).config,
        ref.path,
      ).replace(/\/$/, "");
      if (!unique.has(key)) unique.set(key, ref);
    }
    return [...unique]
      .filter(([key]) => {
        let at = key.lastIndexOf("/");
        while (at >= 0) {
          if (unique.has(key.slice(0, at))) return false;
          at = key.lastIndexOf("/", at - 1);
        }
        return true;
      })
      .map(([, ref]) => ref);
  }
  private pushHistory(ref?: Ref) {
    const current = this.view.history[this.view.historyIndex];
    if ((current ? refKey(current) : "") === (ref ? refKey(ref) : "")) return;
    this.view.history = this.view.history.slice(0, this.view.historyIndex + 1);
    this.view.history.push(ref);
    this.view.history = this.view.history.slice(-200);
    this.view.historyIndex = this.view.history.length - 1;
  }
  async dispatch(
    method: string,
    a: any = {},
    actor: "user" | "agent" = "user",
    client?: string,
  ): Promise<any> {
    if (this.stage !== "running") throw Error("Map is closing");
    if (client && !this.clients.has(client))
      throw Error("Client connection released");
    if (
      a.operationId &&
      [
        "write",
        "transfer",
        "mkdir",
        "mkdirPath",
        "rename",
        "renamePath",
        "delete",
        "package",
        "inventory",
        "search",
        "artifactExport",
        "storageScan",
        "linkProbe",
        "size",
      ].includes(method)
    ) {
      const ordered = (v: any): any =>
        Array.isArray(v)
          ? v.map(ordered)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.keys(v)
                  .sort()
                  .map((k) => [k, ordered(v[k])]),
              )
            : v;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([method, ordered(a)]))
        .digest("hex");
      return this.jobs.operation(a.operationId, fingerprint, (id) =>
        this.execute(method, a, actor, client, {
          id,
          operationId: a.operationId,
          operationFingerprint: fingerprint,
        }),
      );
    }
    const result = await this.execute(method, a, actor, client);
    if (
      [
        "write",
        "transfer",
        "mkdir",
        "mkdirPath",
        "rename",
        "renamePath",
        "delete",
        "package",
        "inventory",
        "artifactExport",
        "storageScan",
        "linkProbe",
        "size",
        "search",
      ].includes(method)
    )
      await this.jobs.durable();
    return result;
  }
  private async execute(
    method: string,
    a: any,
    actor: "user" | "agent",
    client?: string,
    identity?: {
      id: string;
      operationId: string;
      operationFingerprint: string;
    },
  ): Promise<any> {
    const submit = (kind: string, input: any, locks: string[] = []) =>
      this.jobs.submit(kind, input, locks, identity);
    switch (method) {
      case "endpointControl": {
        if (a.action === "disconnect") {
          this.jobs.pauseEndpoint(a.endpoint);
          await this.endpoints.disconnect(a.endpoint);
        } else if (a.action === "connect") {
          const e = this.endpoints.connect(a.endpoint);
          await e.call("info");
          this.directories.invalidate({
            endpoint: a.endpoint,
            path: e.config.root,
          });
        } else throw Error("Unknown connection action");
        this.directories.refreshConnections();
        this.emit("event", {
          type: "endpoints",
          endpoints: this.endpoints.configs(),
        });
        return true;
      }
      case "clientAttach":
        return { view: this.view, tasks: this.jobs.list() };
      case "operation":
        return (await this.jobs.receipt(a.operationId)) ?? null;
      case "jobCleanup":
        return this.jobs.cleanupTask(a.id);
      case "endpoints":
        return this.endpoints.configs();
      case "storageProbe":
        return this.storageAnalysis.probe(a.ref);
      case "storageSnapshots":
        return this.storageAnalysis.list(!!a.includeUnavailable);
      case "storageScan": {
        const volume = await this.storageAnalysis.probe(a.ref);
        return submit("storage", { ...a, volume }, [
          "storage-volume:" + volume.volumeKey,
        ]);
      }
      case "storageCompare":
        return this.storageAnalysis.compare(a);
      case "storageResult":
        return this.storageAnalysis.query(a);
      case "listClose":
        return this.directories.closeClientCursor(a.ref, a.cursor, client);
      case "linkInterfaces":
        return this.links.interfaces(a.endpoint);
      case "linkProbe":
        this.links.validate(a);
        return submit("linkProbe", a, ["link-probe"]);
      case "recordingControl":
        return this.agentRecords.control(a.action, a);
      case "recordingRead":
        return this.agentRecords.page(a);
      case "artifactExport": {
        const ep = this.endpoints.get(a.target.endpoint);
        if (
          !a.source ||
          !["resources", "recording", "storage"].includes(a.source.kind) ||
          !["json", "csv"].includes(a.format ?? "json")
        )
          throw Error("导出参数无效");
        return submit("export", a, [alias(ep.config, a.target.path)]);
      }
      case "workloadRegister":
        if (!this.endpoints.items.has(a.endpoint))
          throw Error("作业端点未登记");
        if (a.projectRef) {
          const ep = this.endpoints.get(a.projectRef.endpoint);
          if (!pathApi(ep.config).isAbsolute(a.projectRef.path))
            throw Error("请选择绝对目录路径");
          const stat = await ep.call<{ kind: string }>("stat", {
            path: a.projectRef.path,
          });
          if (stat.kind !== "directory") throw Error("项目归属需要真实目录");
          a = {
            ...a,
            projectRef: {
              endpoint: a.projectRef.endpoint,
              path: pathApi(ep.config).normalize(a.projectRef.path),
            },
          };
        }
        return this.workloads.register(a);
      case "workloadsPage":
        await this.projectRuns.refresh(this.inspector.projects());
        return {
          ...(await this.workloads.page(
            a.cursor,
            a.limit ?? 30,
            a.observe === false ? undefined : this.observeRuns,
          )),
          indexPending: this.projectRuns.more,
        };
      case "workloadDetail":
        await this.projectRuns.refresh(this.inspector.projects());
        return this.workloads.detail(
          a.runId,
          a.observe ? this.observeRuns : undefined,
        );
      case "workloadForget":
        return this.workloads.forget(a.runId);
      case "modelAnalysis":
        if (!a.ref && !a.view) return this.view.modelSelection ?? null;
        return modelAnalysis(
          this.endpoints,
          a.ref ? a : { ...this.view.modelSelection, ...a },
        );
      case "runProfile": {
        if (a.ref) return this.runProfiles.read(a);
        await this.projectRuns.refresh(this.inspector.projects());
        const entries = [
          ...this.workloads.profiles(),
          ...(await this.runProfiles.list()),
        ];
        return [...new Map(entries.map((e) => [refKey(e.ref), e])).values()];
      }
      case "opsCatalog":
        return this.operations.catalog();
      case "patrolGroups": {
        const { groups, selected } = this.operations.catalog();
        return {
          groups: groups.map(({ id, name, endpoints, mounts }) => ({
            id,
            name,
            endpoints,
            mounts,
          })),
          selected,
        };
      }
      case "opsGroupSave":
        if (actor !== "user") throw Error("请通过资源页保存巡检组");
        return this.operations.saveGroup(a);
      case "opsGroupSelect":
        if (actor !== "user") throw Error("请通过资源页切换巡检组");
        return this.operations.select(a.id);
      case "peerPairSave":
        if (actor !== "user") throw Error("请通过资源页确认直传机器对");
        return this.operations.savePair(a.pair, a.remove === true);
      case "systemResources": {
        const group = a.groupId ? this.operations.group(a.groupId) : undefined;
        if (a.endpoints !== undefined || group) {
          const known = new Set(
            this.endpoints.configs().map((endpoint) => endpoint.id),
          );
          const endpoints =
            a.endpoints ?? group!.endpoints.filter((id) => known.has(id));
          const missing = group?.endpoints.filter((id) => !known.has(id)) ?? [];
          return endpoints.length
            ? {
                ...(await compareMachines(
                  this.monitor,
                  endpoints,
                  a.confirmedShares ?? group?.confirmedShares,
                  a.trends === true,
                  a.reuseRecent === true,
                )),
                missing,
              }
            : { machines: [], shares: [], missing };
        }
        const { compact, ...query } = a;
        const value = await this.monitor.snapshot(query);
        return compact ? compactResourceSnapshot(value) : value;
      }
      case "resources":
        return this.endpoints.get(a.endpoint).call("resources");
      case "diagnostics":
        return {
          storage: this.storageAnalysis.stats(),
          endpointLifecycle: this.endpoints.stats(),
          host: {
            pid: process.pid,
            scope: "shared-extension-host",
            memory: process.memoryUsage(),
            cpu: process.cpuUsage(),
          },
          agents: this.agentStats?.(),
          transfers: this.transfers.stats(),
          direct: this.peer.stats(),
          lifecycle: {
            stage: this.stage,
            clients: this.clients.size,
            recoveryWaiters: this.recovery.size,
          },
          directories: this.directories.stats(),
          jobs: this.jobs.stats(),
          inspector: this.inspector.stats(),
          projectRuns: this.projectRuns.stats(),
          workspaceUi: this.workspaceUiStats?.(),
          environmentUi: this.environmentUiStats?.(),
          monitor: this.monitor.stats(),
          endpoints: [...this.endpoints.items.values()].map((e) => ({
            id: e.config.id,
            connected: !!e.connected,
            enabled: this.endpoints.enabled(e.config.id),
          })),
        };
      case "addEndpoint": {
        this.endpoints.add(a);
        this.emit("event", {
          type: "endpoints",
          endpoints: this.endpoints.configs(),
        });
        return a;
      }
      case "list": {
        const allowed = new Set([
          "name",
          "path",
          "kind",
          "size",
          "mtime",
          "identity",
          "target",
          "error",
        ]);
        if (
          a.fields !== undefined &&
          (!Array.isArray(a.fields) ||
            !a.fields.length ||
            a.fields.some((k: string) => !allowed.has(k)))
        )
          throw Error("Select supported directory entry fields");
        const page = await this.directories.list(
          a.ref,
          a.cursor,
          a.refresh,
          actor === "agent" ? (client ?? "agent") : "ui",
        );
        if (!Array.isArray(a.fields)) return page;
        return {
          ...page,
          entries: page.entries.map((entry) =>
            Object.fromEntries(
              a.fields
                .filter((k: string) => k in entry)
                .map((k: keyof typeof entry) => [k, entry[k]]),
            ),
          ),
        };
      }
      case "stat": {
        const endpoint = this.endpoints.get(a.ref.endpoint);
        const entry = await endpoint.call("stat", { path: a.ref.path });
        if (endpoint.config.kind === "windows" && entry.kind === "symlink")
          Object.assign(
            entry,
            await endpoint.call("linkInfo", { path: a.ref.path }),
          );
        return entry;
      }
      case "read": {
        const limit = Math.min(a.length ?? 1048576, 1048576);
        return {
          data: await this.endpoints.get(a.ref.endpoint).call("read", {
            path: a.ref.path,
            offset: a.offset ?? 0,
            length: limit,
          }),
          encoding: "base64",
          offset: a.offset ?? 0,
        };
      }
      case "write": {
        const e = this.endpoints.get(a.ref.endpoint);
        const b = Buffer.from(
          a.content,
          a.encoding === "base64" ? "base64" : "utf8",
        );
        const dir = path.join(this.storage, "writes");
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const inputFile = path.join(dir, randomUUID());
        await fs.writeFile(inputFile, b, { mode: 0o600 });
        try {
          return submit(
            "mutation",
            {
              method: "write",
              ref: a.ref,
              inputFile,
              exclusive: !!a.exclusive,
            },
            [alias(e.config, a.ref.path)],
          );
        } catch (error) {
          await fs.rm(inputFile, { force: true });
          throw error;
        }
      }
      case "watch":
        this.directories.watch(a.refs);
        return true;
      case "view":
        return this.view;
      case "setView": {
        if (typeof a.patrolFilter === "string") {
          if (a.patrolFilter) this.operations.group(a.patrolFilter);
          this.view.patrolFilter = a.patrolFilter;
        }
        if (a.expanded) this.view.expanded = a.expanded;
        if (a.viewport) this.view.viewport = a.viewport;
        if (a.bookmarks) {
          this.view.bookmarks = a.bookmarks;
          this.emit("event", { type: "bookmarks" });
        }
        if (typeof a.follow === "boolean") this.view.follow = a.follow;
        if (a.manual || a.follow === false) this.navigationRevision++;
        if (a.manual) this.view.follow = false;
        if (a.follow === true && this.view.agent) {
          const agent = this.view.agent,
            revision = ++this.navigationRevision;
          const entry = await this.endpoints
            .get(agent.endpoint)
            .call("stat", { path: agent.path });
          if (revision === this.navigationRevision && this.view.follow) {
            this.view.agentEntry = entry;
            this.view.root =
              entry.kind === "directory"
                ? agent
                : {
                    endpoint: agent.endpoint,
                    path: pathApi(
                      this.endpoints.get(agent.endpoint).config,
                    ).dirname(agent.path),
                  };
            this.pushHistory(this.view.root);
            this.emit("event", { type: "view", view: this.view, focus: true });
          }
        }
        this.saveView();
        return this.view;
      }
      case "navigate": {
        const revision = ++this.navigationRevision;
        const ref = a.ref as Ref | undefined;
        let root = ref;
        let entry;
        if (ref) {
          const e = this.endpoints.get(ref.endpoint);
          entry = await e.call("stat", { path: ref.path });
          if (entry.kind !== "directory")
            root = {
              endpoint: ref.endpoint,
              path: pathApi(e.config).dirname(ref.path),
            };
        }
        if (
          revision !== this.navigationRevision ||
          (client && !this.clients.has(client))
        )
          return this.view;
        if (actor === "agent") {
          this.view.agent = ref;
          this.view.agentEntry = entry;
          if (this.view.follow) {
            this.view.root = root;
            this.pushHistory(root);
          }
        } else {
          this.view.follow = false;
          this.view.root = root;
          this.pushHistory(root);
        }
        this.emit("event", {
          type: "view",
          view: this.view,
          focus: actor === "user" || this.view.follow,
        });
        this.saveView();
        return this.view;
      }
      case "history": {
        this.navigationRevision++;
        const index = Math.max(
          0,
          Math.min(
            this.view.history.length - 1,
            this.view.historyIndex + a.direction,
          ),
        );
        this.view.historyIndex = index;
        this.view.root = this.view.history[index];
        this.view.follow = false;
        this.emit("event", { type: "view", view: this.view, focus: true });
        this.saveView();
        return this.view;
      }
      case "transfer": {
        if (a.workloadId !== undefined) this.workloads.get(a.workloadId);
        if (
          a.workloadPhase !== undefined &&
          (!a.workloadId ||
            typeof a.workloadPhase !== "string" ||
            a.workloadPhase.length > 80)
        )
          throw Error("关联阶段需要有效作业");
        if (
          a.transport !== undefined &&
          !["auto", "relay"].includes(a.transport)
        )
          throw Error("传输方式无效");
        const i = {
          ...a,
          sources: a.sources ? this.selectedRoots(a.sources) : [],
        } as TransferInput;
        if (!i.sources?.length) throw Error("Select source files");
        if (
          !["copy", "move"].includes(i.mode) ||
          !["skip", "rename", "overwrite"].includes(i.conflict)
        )
          throw Error("Explicit mode and conflict rule required");
        const targetConfig = this.endpoints.get(i.target.endpoint).config;
        // Auto-rename can choose another sibling, so it reserves the directory.
        // Fixed destinations reserve their actual paths; independent files can run together.
        const targets =
          i.conflict === "rename"
            ? [i.target]
            : i.sources.map((source) => ({
                endpoint: i.target.endpoint,
                path: pathApi(targetConfig).join(
                  i.target.path,
                  pathApi(this.endpoints.get(source.endpoint).config).basename(
                    source.path,
                  ),
                ),
              }));
        const keys = [...i.sources, ...targets].map((r) =>
          alias(this.endpoints.get(r.endpoint).config, r.path),
        );
        return submit("transfer", i, keys);
      }
      case "mkdir":
      case "rename":
      case "renamePath":
      case "mkdirPath":
      case "delete": {
        const refs: Ref[] =
          method === "delete"
            ? this.selectedRoots(a.refs ?? [a.ref])
            : (a.refs ?? [a.ref]);
        return submit(
          "mutation",
          { method, ...a, ...(method === "delete" ? { refs } : {}) },
          refs.flatMap((r) => {
            const e = this.endpoints.get(r.endpoint);
            const paths = pathApi(e.config);
            if (method === "mkdir")
              return [alias(e.config, paths.join(r.path, a.name))];
            if (method === "rename")
              return [
                alias(e.config, r.path),
                alias(e.config, paths.join(paths.dirname(r.path), a.name)),
              ];
            if (method === "renamePath")
              return [alias(e.config, r.path), alias(e.config, a.dest)];
            return [alias(e.config, r.path)];
          }),
        );
      }
      case "search":
        if (!String(a.query ?? "").trim()) throw Error("请输入搜索名称");
        return submit(method, a);
      case "size":
        return submit(method, a);
      case "inspect":
        return a.environment
          ? this.inspector.environment(a.ref, !!a.refresh)
          : this.inspector.detail(a.ref, !!a.refresh);
      case "workspaces": {
        const items = (await this.workspaceStore?.list()) ?? [];
        const query = String(a.query ?? "")
          .trim()
          .toLowerCase();
        const matching = query
          ? items.filter((item) =>
              [
                item.name,
                item.uri,
                ...item.locations.flatMap(({ ref, endpoint }) => [
                  ref.path,
                  endpoint.id,
                  endpoint.name,
                  endpoint.host,
                ]),
              ].some((value) => value?.toLowerCase().includes(query)),
            )
          : items;
        if (a.limit === undefined && !query) return matching;
        const limit = Number(a.limit ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw Error("Select a workspace limit from 1 to 100");
        return matching.slice(0, limit);
      }
      case "workspaceSave": {
        if (!this.workspaceStore) throw Error("Workspace catalog unavailable");
        const values = await this.workspaceStore.save(a);
        this.emit("event", { type: "workspaces" });
        return values;
      }
      case "environmentSelect":
        return this.inspector.selectEnvironment(a.ref, a.choice);
      case "projects":
        return this.inspector.projects(a.endpoint);
      case "registerProject": {
        if (!a.remove) {
          const entry = await this.endpoints
            .get(a.ref.endpoint)
            .call("stat", { path: a.ref.path });
          if (entry.kind !== "directory")
            throw Error("Select a directory to register a project");
        }
        const projects = this.inspector.register(a.ref, !!a.remove);
        this.emit("event", { type: "projects", projects });
        return projects;
      }
      case "inventory": {
        const key = JSON.stringify([
          a.endpoint,
          a.cwd ?? "",
          a.ecosystem ?? "all",
        ]);
        const previous = this.inventories.get(key);
        if (previous && !identity) {
          const job = this.jobs.records.get(previous);
          if (job && ["running", "queued"].includes(job.state))
            return this.jobs.summary(job);
        }
        const job = submit("inventory", a);
        this.inventories.set(key, job.id);
        return this.jobs.summary(job);
      }
      case "jobsPage":
        return this.jobs.page(
          a.cursor,
          a.limit,
          a.kind === "transfer" ? { workloadId: a.workloadId } : undefined,
        );
      case "jobs":
        return this.jobs.list();
      case "job":
        if (a.fields?.length) {
          const allowed = new Set(["summary", "result", "errors", "logs"]);
          if (
            !Array.isArray(a.fields) ||
            a.fields.some((x: string) => !allowed.has(x))
          )
            throw Error("Unknown job field selection");
          if (a.fields.length === 1 && a.fields[0] === "summary")
            return this.jobs.selectedSummary(a.id);
          const full = await this.jobs.details(a.id, a.offset, a.limit);
          const out: any = { id: full.id, state: full.state };
          if (a.fields.includes("summary"))
            Object.assign(out, this.jobs.summary({ ...full, checkpoint: {} }));
          if (a.fields.includes("result")) out.result = full.result;
          if (a.fields.includes("errors")) {
            out.error = full.error;
            out.errorCount = full.result?.errorCount;
            out.errors = full.result?.errors;
          }
          if (a.fields.includes("logs")) out.logs = full.logs;
          return out;
        }
        return this.jobs.details(a.id, a.offset, a.limit);
      case "jobControl":
        return this.jobs.control(a.id, a.action);
      case "packageCapabilities":
        return capabilities;
      case "packageDiscover":
        return (await this.inspector.discovery(a.endpoint, a.cwd, !!a.refresh))
          .value;
      case "packagePlan":
        return recipe(a);
      case "package": {
        const config = this.endpoints.get(a.endpoint).config;
        const paths = pathApi(config);
        const locks = [alias(config, a.cwd)];
        const global =
          [
            "pip",
            "uv",
            "rustup",
            "cargo",
            "android",
            "winget",
            "java",
            "gradle",
            "maven",
          ].includes(a.manager) ||
          a.action.startsWith("global-") ||
          (a.manager === "flutter" && a.action !== "dependencies");
        if (global) {
          const ecosystem =
            ["pip", "uv"].includes(a.manager) &&
            !a.action.startsWith("tool-") &&
            !a.action.startsWith("cache-")
              ? "python"
              : a.manager;
          const environment =
            a.python && paths.isAbsolute(a.python)
              ? paths.dirname(paths.dirname(a.python))
              : undefined;
          locks.push(
            "package:" +
              a.endpoint +
              ":" +
              ecosystem +
              ":" +
              (environment ?? a.executable ?? "default"),
          );
          if (environment) locks.push(alias(config, environment));
        }
        if (a.entry) locks.push(alias(config, a.entry));
        return submit("package", a, locks);
      }
      case "profile":
        this.profile.record(a.stage, a.fields);
        return true;
      default:
        throw Error("Unknown core method: " + method);
    }
  }
  private async mutate(c: JobContext) {
    const a = c.job.input;
    const refs: Ref[] = a.refs ?? [a.ref];
    for (const r of refs) {
      c.check();
      const e = this.endpoints.get(r.endpoint);
      if (a.method === "write") {
        const data = await fs.readFile(a.inputFile);
        const pp = pathApi(e.config);
        const temp = pp.join(
          pp.dirname(r.path),
          ".workspace-map-" + c.job.id + ".write",
        );
        let original: any;
        try {
          original = await e.call("stat", { path: r.path });
        } catch (error: any) {
          if (
            !["ENOENT", 2].includes(error.code) &&
            error.type !== "FileNotFoundError"
          )
            throw error;
        }
        if (original && a.exclusive) throw Error("Destination exists");
        if (original && original.kind !== "file")
          throw Error("Open the resolved file target before editing");
        for (let i = 0; i < data.length || i === 0; i += 1048576) {
          c.check();
          await e.call("write", {
            path: temp,
            offset: i,
            data: data.subarray(i, i + 1048576).toString("base64"),
            truncate: i + 1048576 >= data.length,
          });
        }
        if (original)
          await e.call("metadata", {
            path: temp,
            mode: original.mode,
            mtime: Date.now(),
          });
        await e.call("rename", {
          path: temp,
          dest: r.path,
          overwrite: !a.exclusive,
        });
        await fs.unlink(a.inputFile);
        this.invalidateParent(r);
      }
      if (a.method === "mkdirPath") {
        await e.call("mkdir", { path: r.path });
        this.invalidateParent(r);
      }
      if (a.method === "renamePath") {
        await e.call("rename", {
          path: r.path,
          dest: a.dest,
          overwrite: !!a.overwrite,
        });
        this.invalidateParent(r);
        this.invalidateParent({ endpoint: r.endpoint, path: a.dest });
      }

      if (a.method === "mkdir") {
        assertName(e.config, a.name);
        await e.call("mkdir", { path: pathApi(e.config).join(r.path, a.name) });
        this.inspector.invalidate(r.endpoint);
        this.directories.invalidate(r);
      }
      if (a.method === "rename") {
        assertName(e.config, a.name);
        await e.call("rename", {
          path: r.path,
          dest: pathApi(e.config).join(
            pathApi(e.config).dirname(r.path),
            a.name,
          ),
          overwrite: false,
        });
        this.invalidateParent(r);
      }
      if (a.method === "delete") {
        if (pathApi(e.config).parse(r.path).root === r.path)
          throw Error("Root deletion is not supported");
        c.log(
          e.config.kind === "windows"
            ? "回收站: " + r.path
            : "永久删除: " + r.path,
        );
        await e.call("remove", {
          path: r.path,
          recursive: true,
          trash: e.config.kind === "windows",
        });
        this.invalidateParent(r);
      }
      c.progress({ files: c.job.files + 1 });
    }
    return { files: c.job.files };
  }
  private async scan(c: JobContext, kind: "search" | "size") {
    const { ref, query } = c.job.input;
    const e = this.endpoints.get(ref.endpoint);
    if (kind === "size") {
      const entry = await e.call("stat", { path: ref.path });
      if (entry.kind !== "directory") {
        const result = {
          bytes: entry.size,
          files: entry.kind === "file" ? 1 : 0,
          entry,
          incomplete: entry.kind === "denied",
        };
        c.progress({ bytes: result.bytes, files: result.files });
        return result;
      }
    }
    let cursor: string | undefined;
    let total = 0;
    const results: any[] = [];
    const errors: any[] = [];
    let errorCount = 0;
    try {
      do {
        c.check();
        const p = await e.call("list", {
          path: ref.path,
          kind,
          query,
          cursor,
          limit: 200,
        });
        cursor = p.cursor;
        total += p.entries.length;
        if (p.errors?.length) {
          errorCount += p.errors.length;
          errors.push(...p.errors.slice(0, Math.max(0, 100 - errors.length)));
          c.log(JSON.stringify({ stage: "scan.errors", errors: p.errors }));
        }
        if (kind === "search") {
          results.push(
            ...p.entries.map((x: any) => ({ ...x, endpoint: ref.endpoint })),
          );
          if (results.length > 10000)
            throw Error("Search reached 10,000 results; narrow the subtree");
          this.emit("event", {
            type: "search",
            jobId: c.job.id,
            operationId: c.job.operationId,
            entries: p.entries.map((x: any) => ({
              ...x,
              endpoint: ref.endpoint,
            })),
          });
        }
        c.progress({
          files: kind === "size" ? p.files : total,
          bytes: p.bytes,
          result:
            kind === "search"
              ? {
                  entries: results,
                  errorCount,
                  errors,
                  incomplete: errorCount > 0,
                }
              : {
                  bytes: p.bytes,
                  files: p.files,
                  errorCount,
                  errors,
                  incomplete: errorCount > 0,
                },
        });
        await new Promise((r) => setTimeout(r, 0));
      } while (cursor);
    } finally {
      if (cursor) await e.call("scanClose", { cursor }).catch(() => {});
    }
    return c.job.result;
  }
  dispose() {
    return (this.closing ??= this.close());
  }
  private async close() {
    const deadline = Date.now() + EXIT_GRACE_MS;
    this.stage = "draining";
    clearTimeout(this.timer);
    for (const timer of this.recovery.values()) clearTimeout(timer);
    this.recovery.clear();
    for (const id of this.clients) this.releaseClient(id);
    const cache = this.directories.snapshot();
    this.directories.dispose();
    const releasingIndex = this.projectRuns.release();
    await this.monitor.dispose();
    try {
      await this.jobs.dispose(() => {
        this.peer.abort();
        this.endpoints.abort();
        this.storageAnalysis.abort();
      });
      this.stage = "persisting";
      await this.workloads.durable();
      await this.inspector.dispose();
      await this.persist(cache);
    } finally {
      this.stage = "helpers";
      try {
        await this.storageAnalysis.dispose(deadline);
        await this.endpoints.dispose(deadline);
        await releasingIndex;
        await this.directories.drain();
      } finally {
        this.stage = "closed";
        this.profile.record("map.closed", {
          jobs: this.jobs.stats(),
          directories: this.directories.stats(),
        });
        this.removeAllListeners();
        this.profile.stop();
      }
    }
  }
}
