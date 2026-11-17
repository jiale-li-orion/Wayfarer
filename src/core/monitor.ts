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
  section?: "summary" | "processes" | "gpus" | "io" | "process" | "gpu";
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
  history: Sample[];
};
export class SystemMonitor extends EventEmitter {
  projects?: () => { endpoint: string; path: string }[];
  private states = new Map<string, State>();
  private readers = new Map<string, ResourceQuery>();
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private retiring = new Set<Promise<void>>();
  private recording?: { file: string; count: number };
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
      for (const s of this.states.values())
        if (!s.pending.size) void this.release(s);
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
    const queries: ResourceQuery[] = summary
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
  async snapshot(query: ResourceQuery = {}): Promise<Sample> {
    if (this.disposed) throw Error("Resource monitor closed");
    if (!query.endpoint) {
      const machines = this.machines();
      return {
        machines: machines.map(({ config, ...m }) => m),
        snapshots: machines
          .map((m) => this.states.get(m.id)?.last)
          .filter(Boolean),
        recording: this.recording,
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
      !["summary", "processes", "gpus", "io", "process", "gpu"].includes(
        args.section,
      )
    )
      throw Error("Unknown resource section");
    const key = JSON.stringify(args);
    const cached = s.cache.get(key);
    if (cached && Date.now() - cached.at < 2000) return cached.value;
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
        const afterTransport = s.channel.transportStats?.();
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
        const value = {
          ...s.last,
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
        if (!this.active() && !s.pending.size) void this.release(s);
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
  async startRecording() {
    if (this.disposed) throw Error("Resource monitor closed");
    if (this.recording) return this.recording;
    await fs.mkdir(path.join(this.storage, "resource-recordings"), {
      recursive: true,
    });
    const file = path.join(
      this.storage,
      "resource-recordings",
      Date.now() + "-" + randomUUID() + ".jsonl",
    );
    await fs.writeFile(file, "", { mode: 0o600 });
    this.recording = { file, count: 0 };
    this.schedule();
    void this.tick();
    return this.recording;
  }
  async stopRecording() {
    const result = this.recording;
    this.recording = undefined;
    this.watch("__recording__", undefined);
    await this.writes;
    return result;
  }
  private record(value: Sample) {
    const rec = this.recording;
    if (!rec) return;
    if (this.queuedWrites >= 32) {
      this.recording = undefined;
      this.watch("__recording__");
      this.emit("recordingError", "Recording storage is falling behind");
      return;
    }
    const { history, ...data } = value;
    this.queuedWrites++;
    this.writes = this.writes
      .then(() => fs.appendFile(rec.file, JSON.stringify(data) + "\n"))
      .then(
        () => {
          rec.count++;
        },
        (error) => {
          this.recording = undefined;
          this.watch("__recording__");
          this.emit("recordingError", String(error));
        },
      )
      .finally(() => {
        this.queuedWrites--;
      });
  }
  async readRecording(file: string) {
    await this.writes;
    // Callers can only export files created in this map's recording directory.
    const root = path.join(this.storage, "resource-recordings");
    if (path.dirname(file) !== root) throw Error("Unknown recording");
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
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.readers.clear();
    this.recording = undefined;
    await Promise.all([...this.states.values()].map((s) => this.release(s)));
    await Promise.all([...this.states.values()].map((s) => s.chain));
    await this.writes;
    await Promise.all([...this.retiring]);
    this.states.clear();
    this.removeAllListeners();
  }
}
