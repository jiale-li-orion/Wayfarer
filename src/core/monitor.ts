import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { RemoteEndpoint } from "../adapters/remote";
import type { EndpointConfig } from "../shared/types";
import type { Profiler } from "./log";
import { EXIT_GRACE_MS } from "./lifecycle";

export interface ResourceQuery {
  endpoint?: string;
  section?:
    | "summary"
    | "processes"
    | "gpus"
    | "io"
    | "process"
    | "gpu"
    | "comparison"
    | "identities";
  selectedOnly?: boolean;
  pids?: number[];
  paths?: string[];
  search?: string;
  sort?: string;
  offset?: number;
  limit?: number;
  pid?: number;
  identity?: string;
  gpu?: string;
}
export interface Machine {
  id: string;
  name: string;
  kind: string;
  endpoint: string;
  roots: { endpoint: string; path: string }[];
  config: EndpointConfig;
}
type Channel = Pick<RemoteEndpoint, "call" | "dispose" | "abort"> & {
  transportStats?: () => Record<string, number>;
};
type Sample = Record<string, any>;
type State = {
  channel?: Channel;
  chain: Promise<void>;
  pending: Map<string, Promise<Sample>>;
  cache: Map<string, { at: number; value: Sample }>;
  baseline?: any;
  last?: Sample;
  lastComparison?: Sample;
  volumeTrends?: Record<string, { stamp: number; available: number }[]>;
  history: Sample[];
};
export class SystemMonitor extends EventEmitter {
  projects?: () => { endpoint: string; path: string }[];
  private states = new Map<string, State>();
  private readers = new Map<string, ResourceQuery>();
  private comparisons = new Map<string, Set<string>>();
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private retiring = new Set<Promise<void>>();
  private recording?: {
    file: string;
    count: number;
    bytes: number;
    started: number;
    deadline: number;
    last: Map<string, number>;
  };
  private recordingTimer?: NodeJS.Timeout;
  private recordingStart?: Promise<any>;
  private writes = Promise.resolve();
  private queuedWrites = 0;
  private sweep = 0;
  constructor(
    private configs: () => EndpointConfig[],
    private helper: string,
    private storage: string,
    private profile: Profiler,
    private localPython?: string,
    private factory: (c: EndpointConfig) => Channel = (c) =>
      new RemoteEndpoint(c, helper, (message) =>
        profile.record("monitor.transport", { message }),
      ),
    private enabled: (endpoint: string) => boolean = () => true,
    private recordingOptions: {
      directory?: string;
      durationMs?: number;
      maxBytes?: number;
    } = {},
  ) {
    super();
  }
  machines(): Machine[] {
    const groups = new Map<string, Machine>();
    for (const c of this.configs()) {
      const id =
        c.kind === "windows"
          ? "windows"
          : c.kind === "local"
            ? "local"
            : c.kind === "wsl"
              ? "wsl:" + c.distro
              : JSON.stringify([
                  c.kind,
                  c.host,
                  c.sshConfig,
                  c.distro,
                  c.python,
                ]);
      let m = groups.get(id);
      if (!m) {
        m = {
          id,
          name:
            c.kind === "windows"
              ? "Windows"
              : c.kind === "wsl"
                ? "WSL · " + c.distro
                : c.name,
          kind: c.kind,
          endpoint: c.id,
          roots: [],
          config: {
            ...c,
            python: ["windows", "local"].includes(c.kind)
              ? (this.localPython ?? c.python)
              : c.python,
          },
        };
        groups.set(id, m);
      }
      m.roots.push({ endpoint: c.id, path: c.root });
    }
    return [...groups.values()];
  }
  private state(id: string): State {
    let s = this.states.get(id);
    if (!s) {
      s = {
        chain: Promise.resolve(),
        pending: new Map(),
        cache: new Map(),
        history: [],
      };
      this.states.set(id, s);
    }
    return s;
  }
  retainComparison(owner: string, endpoints: string[]) {
    if (this.disposed) return;
    const previous = this.comparisons.get(owner) ?? new Set<string>();
    const selected = new Set(endpoints);
    const next = new Set(this.machines().filter((m) =>
      selected.has(m.endpoint) || m.roots.some((r) => selected.has(r.endpoint))
    ).map((m) => m.id));
    if (next.size) this.comparisons.set(owner, next);
    else this.comparisons.delete(owner);
    if (!this.active()) for (const id of previous) {
      const state = this.states.get(id);
      if (state && !state.pending.size && !this.held(id)) void this.release(state);
    }
  }

  private held(id: string) {
    return [...this.comparisons.values()].some((machines) => machines.has(id));
  }

  private active() {
    return this.readers.size > 0 || !!this.recording;
  }
  private schedule() {
    if (this.timer || !this.active() || this.disposed) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
  }
  watch(owner: string, query?: ResourceQuery) {
    if (this.disposed) return;
    if (query) this.readers.set(owner, query);
    else this.readers.delete(owner);
    if (this.active()) {
      this.schedule();
      if (query) void this.tick(owner);
    } else {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      for (const [id, s] of this.states)
        if (!s.pending.size && !this.held(id)) void this.release(s);
    }
  }
  private async tick(owner?: string) {
    const selections = owner
      ? [this.readers.get(owner)!]
      : [...this.readers.values()];
    const machines = this.machines();
    // Summaries every ten seconds; selected tabs every five seconds. Per-machine requests merge below.
    const summary = !!owner || this.sweep++ % 2 === 0;
    const detailed = new Set(
      selections
        .filter((q) => q?.endpoint && q.section !== "io")
        .map((q) => q.endpoint),
    );
    const queries: ResourceQuery[] =
      summary &&
      (!!this.recording || selections.some((q) => q && !q.selectedOnly))
        ? machines
            .filter((m) => !detailed.has(m.endpoint))
            .map((m) => ({ endpoint: m.endpoint, section: "summary" }))
        : [];
    for (const q of selections) if (q?.endpoint) queries.push(q);
    const queue = queries.slice();
    const worker = async () => {
      while (queue.length && !this.disposed && this.active()) {
        const q = queue.shift()!;
        if (q.section !== "summary" && ![...this.readers.values()].includes(q))
          continue;
        const machine = machines.find((m) => m.endpoint === q.endpoint);
        // A slow snapshot is shared; UI changes replace interest instead of queuing old tabs.
        if (machine && this.states.get(machine.id)?.pending.size) continue;
        try {
          const value = await this.snapshot(q);
          if (this.active()) this.emit("sample", value);
        } catch (error) {
          this.profile.record("monitor.error", {
            endpoint: q.endpoint,
            error: String(error),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, worker),
    );
  }
  recentComparison(endpoint: string) {
    const machine = this.machines().find((m) => m.roots.some((r) => r.endpoint === endpoint));
    if (!machine || !this.enabled(machine.endpoint)) return undefined;
    const sample = this.states.get(machine.id)?.lastComparison;
    return sample && Date.now() - sample.stamp < 30000 ? sample : undefined;
  }
  async snapshot(query: ResourceQuery = {}): Promise<Sample> {
    if (this.disposed) throw Error("Resource monitor closed");
    if (!query.endpoint) {
      const machines = this.machines();
      return {
        machines: machines.map(({ config, ...m }) => m),
        snapshots: machines
          .map((m) => this.states.get(m.id)?.last)
          .filter(Boolean),
        recording: this.recording
          ? {
              file: this.recording.file,
              count: this.recording.count,
              bytes: this.recording.bytes,
              deadline: this.recording.deadline,
            }
          : undefined,
        stats: this.stats(),
      };
    }
    const machine = this.machines().find(
      (m) =>
        m.endpoint === query.endpoint ||
        m.roots.some((r) => r.endpoint === query.endpoint) ||
        m.id === query.endpoint,
    );
    if (!machine) throw Error("Unknown resource endpoint");
    const s = this.state(machine.id);
    const args = {
      ...query,
      endpoint: machine.endpoint,
      section: query.section ?? "summary",
    };
    if (
      ![
        "summary",
        "processes",
        "gpus",
        "io",
        "process",
        "gpu",
        "comparison",
        "identities",
      ].includes(args.section)
    )
      throw Error("Unknown resource section");
    const key = JSON.stringify(args);
    const cached = s.cache.get(key);
    if (
      cached &&
      this.enabled(machine.endpoint) &&
      Date.now() - cached.at < 2000
    )
      return cached.value;
    const pending = s.pending.get(key);
    if (pending) return pending;
    const task = s.chain.then(async () => {
      if (this.disposed) throw Error("Resource monitor closed");
      const start = performance.now();
      try {
        if (!this.enabled(machine.endpoint))
          throw Error("Endpoint explicitly disconnected");
        const cold = !s.channel;
        s.channel ??= this.factory(machine.config);
        const beforeTransport = s.channel.transportStats?.();
        const raw = await s.channel.call<Sample>("snapshot", {
          ...args,
          _baseline: cold ? s.baseline : undefined,
          _checkpoint: !this.active(),
        });
        if (!this.enabled(machine.endpoint))
          throw Error("Endpoint explicitly disconnected");
        if (args.section === "identities")
          return {
            endpoint: machine.endpoint,
            status: "online",
            stamp: raw.stamp,
            identities: raw.identities,
            bootId: raw.bootId,
            reports: raw.reports,
          };
        const afterTransport = s.channel.transportStats?.();
        if (machine.kind === "wsl") {
          const host = this.machines().find((m) => m.kind === "windows");
          if (host) {
            const known = this.states.get(host.id)?.last;
            const windows =
              known && Date.now() - known.stamp < 10000
                ? known
                : await this.snapshot({
                    endpoint: host.endpoint,
                    section: "summary",
                  });
            const budget = windows.system?.storage?.wsl?.find(
              (v: any) => v.distribution === machine.config.distro,
            );
            if (budget)
              raw.physicalBudget = {
                ...budget,
                stamp: windows.stamp,
                scope: "windows-backing-volume",
              };
          }
        }
        if (raw._baseline) s.baseline = raw._baseline;
        delete raw._baseline;
        if (raw.detail?.cwd) {
          const cwd = raw.detail.cwd.replaceAll("\\", "/");
          const project = this.projects?.()
            .filter((ref) =>
              machine.roots.some((root) => root.endpoint === ref.endpoint),
            )
            .filter(
              (ref) =>
                cwd === ref.path.replaceAll("\\", "/") ||
                cwd.startsWith(
                  ref.path.replaceAll("\\", "/").replace(/\/$/, "") + "/",
                ),
            )
            .sort((a, b) => b.path.length - a.path.length)[0];
          if (project)
            raw.detail.project = { ...project, source: "registered-project" };
        }
        if (args.section === "comparison") {
          const next: NonNullable<State["volumeTrends"]> = {};
          for (const volume of raw.mounts ?? []) {
            const key = JSON.stringify([volume.path, volume.source, volume.serverAddress, volume.route]);
            if (volume.available == null) continue;
            const points = s.volumeTrends?.[key] ?? [];
            if (raw.stamp - (points.at(-1)?.stamp ?? 0) >= 4000)
              points.push({ stamp: raw.stamp, available: volume.available });
            while (points.length > 60 || points[0]?.stamp < raw.stamp - 600000)
              points.shift();
            next[key] = points;
          }
          s.volumeTrends = next;
          raw.mounts = (raw.mounts ?? []).map((volume: any) => ({
            ...volume, trend: next[JSON.stringify([volume.path, volume.source, volume.serverAddress, volume.route])]?.slice(),
          }));
        }
        const value = {
          ...raw,
          gpus: raw.gpus ?? s.last?.gpus,
          endpoint: machine.endpoint,
          machine: machine.id,
          name: machine.name,
          section: args.section,
          status: "online",
          history: s.history.slice(),
          query: args,
        };
        s.last = value;
        if (args.section === "comparison") s.lastComparison = value;
        const point = {
          stamp: raw.stamp,
          cpuPercent: raw.system?.cpuPercent,
          memoryUsed: raw.system?.memory?.used,
          memoryTotal: raw.system?.memory?.total,
          gpus: raw.gpus?.map((g: any) => ({
            id: g.id,
            utilization: g.utilization,
            memoryUsed: g.memoryUsed ?? g.dedicatedUsed,
          })),
          gpuMemoryUsed: raw.gpus?.reduce(
            (n: number, g: any) => n + (g.memoryUsed ?? 0),
            0,
          ),
        };
        if (
          !s.history.length ||
          raw.stamp - s.history[s.history.length - 1].stamp >= 4000
        )
          s.history.push(point);
        while (
          s.history.length > 120 ||
          s.history[0]?.stamp < Date.now() - 600000
        )
          s.history.shift();
        s.cache.set(key, { at: Date.now(), value });
        while (s.cache.size > 8) s.cache.delete(s.cache.keys().next().value!);
        this.profile.record("monitor.sample", {
          machine: machine.name,
          section: args.section,
          ms: performance.now() - start,
          receivedBytes:
            afterTransport && beforeTransport
              ? afterTransport.receivedBytes - beforeTransport.receivedBytes
              : undefined,
          sentBytes:
            afterTransport && beforeTransport
              ? afterTransport.sentBytes - beforeTransport.sentBytes
              : undefined,
          collector: raw.collector,
        });
        this.record(value);
        return value;
      } catch (error) {
        await this.release(s);
        if (args.section === "identities")
          return {
            endpoint: machine.endpoint,
            status: "offline",
            error: String(error),
          };
        const value = {
          ...(args.section === "comparison" ? s.lastComparison ?? s.last : s.last),
          endpoint: machine.endpoint,
          machine: machine.id,
          name: machine.name,
          section: args.section,
          query: args,
          status: "offline",
          error: String(error),
          history: s.history.slice(),
        };
        this.emit("sample", value);
        return value;
      }
    });
    s.chain = task.then(
      () => {},
      () => {},
    );
    s.pending.set(key, task);
    void task
      .finally(() => {
        s.pending.delete(key);
        if (!this.active() && !s.pending.size && !this.held(machine.id)) void this.release(s);
      })
      .catch(() => {});
    return task;
  }
  private async release(s: State) {
    const channel = s.channel;
    s.channel = undefined;
    if (channel) {
      let closing: Promise<void>;
      closing = Promise.resolve(channel.dispose(Date.now() + EXIT_GRACE_MS))
        .catch((error) =>
          this.profile.record("monitor.close.error", { error: String(error) }),
        )
        .finally(() => this.retiring.delete(closing));
      this.retiring.add(closing);
      await closing;
    }
  }
  startRecording() {
    if (this.recordingStart) return this.recordingStart;
    this.recordingStart = this.beginRecording().finally(() => {
      this.recordingStart = undefined;
    });
    return this.recordingStart;
  }
  recordingDirectory() {
    return (
      this.recordingOptions.directory ??
      path.join(this.storage, "resource-recordings")
    );
  }
  private async beginRecording() {
    if (this.disposed) throw Error("Resource monitor closed");
    if (this.recording) return this.recording;
    const directory = this.recordingDirectory();
    if (!path.isAbsolute(directory))
      throw Error("Recording directory must be absolute");
    await fs.mkdir(directory, {
      recursive: true,
    });
    const file = path.join(
      directory,
      Date.now() + "-" + randomUUID() + ".jsonl",
    );
    await fs.writeFile(file, "", { mode: 0o600 });
    if (this.disposed) {
      await fs.rm(file, { force: true });
      throw Error("Resource monitor closed");
    }
    const started = Date.now();
    this.recording = {
      file,
      count: 0,
      bytes: 0,
      started,
      deadline:
        started + Math.min(600000, this.recordingOptions.durationMs ?? 600000),
      last: new Map(),
    };
    this.recordingTimer = setTimeout(
      () => void this.stopRecording("duration"),
      this.recording.deadline - started,
    );
    this.recordingTimer.unref();
    this.schedule();
    void this.tick();
    return this.recording;
  }
  async stopRecording(reason = "user") {
    if (this.recordingStart) await this.recordingStart;
    const result = this.recording;
    this.recording = undefined;
    clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
    this.watch("__recording__", undefined);
    if (result) this.emit("recordingStopped", { file: result.file, reason });
    await this.writes;
    return result;
  }
  private record(value: Sample) {
    const rec = this.recording;
    if (!rec) return;
    const key = String(value.machine ?? value.endpoint);
    if (Date.now() - (rec.last.get(key) ?? 0) < 10000) return;
    const { history, ...data } = value;
    const line = JSON.stringify(data) + "\n";
    const bytes = Buffer.byteLength(line);
    if (
      rec.bytes + bytes >
      Math.min(20 * 2 ** 20, this.recordingOptions.maxBytes ?? 20 * 2 ** 20)
    ) {
      void this.stopRecording("size");
      return;
    }
    if (this.queuedWrites >= 32) {
      void this.stopRecording("backpressure");
      this.emit("recordingError", "记录写入滞后，已结束本次录制");
      return;
    }
    rec.bytes += bytes;
    rec.last.set(key, Date.now());
    this.queuedWrites++;
    this.writes = this.writes
      .then(() => fs.appendFile(rec.file, line))
      .then(
        () => {
          rec.count++;
        },
        (error) => {
          if (this.recording === rec) {
            void this.stopRecording("write-error");
            this.emit("recordingError", String(error));
          }
        },
      )
      .finally(() => {
        this.queuedWrites--;
      });
  }
  async readRecording(file: string) {
    await this.writes;
    // Callers can only export files created in this map's recording directory.
    const root = this.recordingDirectory();
    if (
      ![root, path.join(this.storage, "resource-recordings")].includes(
        path.dirname(file),
      )
    )
      throw Error("Unknown recording");
    const readline = await import("node:readline");
    const size = (await fs.stat(file)).size;
    const stream = (await import("node:fs")).createReadStream(file, {
      end: Math.max(0, size - 1),
    });
    return {
      stream,
      lines: readline.createInterface({ input: stream, crlfDelay: Infinity }),
    };
  }
  stats() {
    return {
      readers: this.readers.size,
      comparisonViews: this.comparisons.size,
      machines: this.states.size,
      historyPoints: [...this.states.values()].reduce(
        (n, s) => n + s.history.length,
        0,
      ),
      timer: !!this.timer,
      recording: !!this.recording,
      queuedWrites: this.queuedWrites,
      retiringChannels: this.retiring.size,
      channels: [...this.states.values()].filter((s) => s.channel).length,
      pending: [...this.states.values()].reduce(
        (n, s) => n + s.pending.size,
        0,
      ),
      cached: [...this.states.values()].reduce((n, s) => n + s.cache.size, 0),
    };
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.recordingStart?.catch(() => {});
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.readers.clear();
    this.comparisons.clear();
    clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
    this.recording = undefined;
    await Promise.all([...this.states.values()].map((s) => this.release(s)));
    await Promise.all([...this.states.values()].map((s) => s.chain));
    await this.writes;
    await Promise.all([...this.retiring]);
    this.states.clear();
    this.removeAllListeners();
  }
}
