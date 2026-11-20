import fs, { type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RemoteEndpoint } from "../adapters/remote";
import type { EndpointConfig, Ref } from "../shared/types";
import type { JobContext } from "./jobs";
import { pathApi } from "../shared/paths";
import type { Profiler } from "./log";

/** Snapshot rows live in SQLite; neither Core nor the Webview keeps a file manifest. */
export class StorageAnalysis {
  private channels = new Set<RemoteEndpoint>();
  private closed = false;
  private pruning = Promise.resolve();
  private readLeases = new Map<string, number>();
  constructor(
    private directory: string,
    private helper: string,
    private config: (id: string) => EndpointConfig,
    private profile: Profiler,
    private python?: string,
  ) {}
  private channel(config?: EndpointConfig) {
    if (this.closed) throw Error("Storage analysis closed");
    const c = new RemoteEndpoint(
      config ?? {
        id: "storage-local",
        name: "Storage index",
        root: path.parse(this.directory).root,
        kind: process.platform === "win32" ? "windows" : "local",
        python: this.python,
      },
      this.helper,
      (message) => this.profile.record("storage.transport", { message }),
    );
    this.channels.add(c);
    return c;
  }
  private async release(c: RemoteEndpoint) {
    await c.dispose();
    this.channels.delete(c);
  }
  private db(id: string) {
    if (!/^(?:op-)?[a-zA-Z0-9-]+$/.test(id)) throw Error("Invalid snapshot ID");
    return path.join(this.directory, id + ".sqlite");
  }
  private native(c: EndpointConfig) {
    return ["windows", "local"].includes(c.kind);
  }
  private source(c: EndpointConfig) {
    return this.native(c) ? { ...c, python: this.python ?? c.python } : c;
  }
  async probe(ref: Ref) {
    const config = this.config(ref.endpoint);
    if (!pathApi(config).isAbsolute(ref.path))
      throw Error("An absolute endpoint path is required");
    const c = this.channel(this.source(config));
    try {
      const value = await c.call("probe", { path: ref.path });
      let volume = value.volume;
      if (
        config.kind === "wsl" &&
        value.windowsDrive &&
        process.platform === "win32"
      ) {
        const win = this.config(
          "windows-" + value.windowsDrive[0].toLowerCase(),
        );
        const native = this.channel(this.source(win));
        try {
          const counterpart = await native.call("probe", {
            path:
              value.windowsDrive +
              "\\" +
              ref.path.slice(7).replaceAll("/", "\\"),
          });
          volume = counterpart.volume;
          value.windowsVolume = volume;
        } finally {
          await this.release(native);
        }
      }
      if (
        config.kind === "wsl" &&
        !value.windowsDrive &&
        process.platform === "win32"
      ) {
        const drive = (process.env.SystemDrive ?? "C:")[0].toLowerCase();
        const native = this.channel(
          this.source(this.config("windows-" + drive)),
        );
        try {
          const host = await native.call("probe", {
            path: (process.env.SystemDrive ?? "C:") + "\\",
          });
          const backing = host.wsl?.find(
            (w: any) => w.distribution === config.distro,
          );
          value.volumeCapacityKind = "virtual-filesystem";
          if (backing) {
            value.backing = backing;
            value.physicalBudget = backing.hostVolume;
            volume = backing.hostVolume.volume;
            value.windowsVolume = volume;
          }
        } finally {
          await this.release(native);
        }
      }
      const machine =
        config.kind === "windows" ||
        (config.kind === "wsl" && value.windowsVolume)
          ? "windows"
          : JSON.stringify([
              config.kind,
              config.host,
              config.distro,
              config.sshConfig,
            ]);
      return { ...value, ref, volumeKey: machine + ":" + volume };
    } finally {
      await this.release(c);
    }
  }
  async run(ctx: JobContext) {
    const { ref } = ctx.job.input;
    const config = this.config(ref.endpoint);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const store = this.db(ctx.job.id);
    if (this.readLeases.has(ctx.job.id))
      throw Error("Snapshot is being read; start a fresh scan");
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      await fs.rm(store + suffix, { force: true });
    const source = this.channel(this.source(config));
    const index = this.native(config) ? source : this.channel();
    let snapshot: any;
    const started = performance.now();
    let completed = false;
    try {
      snapshot = await source.call("begin", {
        path: ref.path,
        volume: ctx.job.input.volume,
        ...(index === source ? { store } : {}),
      });
      while (true) {
        ctx.check();
        const page = await source.call("page");
        snapshot = page.snapshot;
        if (index !== source)
          await index.call("import", { store, rows: page.rows, snapshot });
        const { topFiles, errors, ...summary } = snapshot;
        ctx.progress({
          bytes: snapshot.rootStats?.allocatedBytesKnown ?? 0,
          files: snapshot.files,
          result: {
            snapshotId: ctx.job.id,
            ...summary,
            errorCount: snapshot.errorCount,
          },
        });
        if (page.done) {
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return {
        snapshotId: ctx.job.id,
        ref,
        files: snapshot.files,
        directories: snapshot.directories,
        ...snapshot.rootStats,
        incomplete: snapshot.incomplete,
        errorCount: snapshot.errorCount,
        elapsedMs: performance.now() - started,
      };
    } finally {
      try {
        if (snapshot && !completed) {
          snapshot.finished = false;
          snapshot.incomplete = true;
          await index
            .call("import", { store, snapshot, rows: [] })
            .catch(() => {});
        }
        await source.call("close").catch(() => {});
      } finally {
        await this.release(source);
        if (index !== source) await this.release(index);
        const data = await fs.stat(store).catch(() => undefined);
        if (data) {
          await fs.writeFile(
            path.join(this.directory, ctx.job.id + ".json"),
            JSON.stringify({
              id: ctx.job.id,
              ref,
              stamp: Date.now(),
              finished: completed,
              available: true,
              bytes: data.size,
            }),
          );
        }
        this.profile.record("storage.scan", {
          ref,
          job: ctx.job.id,
          completed,
          elapsedMs: performance.now() - started,
          cpuMs: snapshot?.cpuMs,
          resources: snapshot?.resources,
          files: snapshot?.files,
          transport: source.transportStats(),
          snapshotBytes: data?.size,
        });
        await this.prune();
      }
    }
  }
  async query(a: {
    id: string;
    directory?: string;
    offset?: number;
    limit?: number;
  }) {
    const store = this.db(a.id);
    await fs.access(store).catch(async () => {
      const row = await fs
        .readFile(path.join(this.directory, a.id + ".json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      throw Error(
        "Snapshot expired or unavailable: " +
          (row?.evictionReason ?? "missing-index") +
          ". Retention keeps three snapshots within 100 MiB; export retained results before another scan.",
      );
    });
    this.readLeases.set(a.id, (this.readLeases.get(a.id) ?? 0) + 1);
    let c: RemoteEndpoint | undefined;
    const started = performance.now();
    try {
      c = this.channel();
      const value = await c.call("query", { store, ...a });
      this.profile.record("storage.query", {
        job: a.id,
        elapsedMs: performance.now() - started,
        responseBytes: Buffer.byteLength(JSON.stringify(value)),
        rows: value.rows.length,
      });
      return value;
    } finally {
      if (c) await this.release(c);
      const n = this.readLeases.get(a.id)! - 1;
      if (n) this.readLeases.set(a.id, n);
      else this.readLeases.delete(a.id);
      await this.prune();
    }
  }
  async compare(a: {
    before: string;
    after: string;
    directory?: string;
    offset?: number;
    limit?: number;
  }) {
    const rows = await this.list();
    const before = rows.find((r) => r.id === a.before),
      after = rows.find((r) => r.id === a.after);
    if (!before || !after)
      throw Error("Comparison requires two retained snapshots");
    const config = this.config(before.ref.endpoint);
    const normalized = (v: string) => {
      const p = pathApi(config).resolve(v);
      return config.kind === "windows" ? p.toLowerCase() : p;
    };
    if (
      before.ref.endpoint !== after.ref.endpoint ||
      normalized(before.ref.path) !== normalized(after.ref.path)
    )
      throw Error("Comparison requires the same endpoint and scan root");
    const ids = [...new Set([a.before, a.after])];
    for (const id of ids)
      this.readLeases.set(id, (this.readLeases.get(id) ?? 0) + 1);
    const c = this.channel();
    try {
      return await c.call("compare", {
        ...a,
        beforeStore: this.db(a.before),
        afterStore: this.db(a.after),
      });
    } finally {
      await this.release(c);
      for (const id of ids) {
        const n = this.readLeases.get(id)! - 1;
        if (n) this.readLeases.set(id, n);
        else this.readLeases.delete(id);
      }
      await this.prune();
    }
  }
  async exportTo(id: string, output: string, before?: string,check=()=>{}) {
    this.db(id);
    if (
      path.resolve(output).startsWith(path.resolve(this.directory) + path.sep)
    )
      throw Error("Choose an export location outside the snapshot index");
    const pinned = [...new Set(before ? [before, id] : [id])];
    for (const key of pinned) {
      this.db(key);
      this.readLeases.set(key, (this.readLeases.get(key) ?? 0) + 1);
    }
    const partial = output + ".workspace-map-" + randomUUID() + ".partial";
    let file: FileHandle | undefined;
    let owned = false;
    try {
      file = await fs.open(partial, "wx", 0o600);
      owned = true;
      let offset = 0,
        first = true;
      while (true) {
        check();
        const page = before
          ? await this.compare({ before, after: id, offset, limit: 200 })
          : await this.query({
              id,
              directory: "*",
              offset,
              limit: 200,
            });
        if (offset === 0)
          await file.write(
            (before
              ? '{"comparison":' + JSON.stringify({ ...page, rows: undefined })
              : '{"snapshot":' + JSON.stringify(page.snapshot)) +
              ',"directories":[\n',
          );
        for (const row of page.rows) {
          await file.write((first ? "" : ",\n") + JSON.stringify(row));
          first = false;
        }
        if (!page.hasMore) break;
        offset += page.rows.length;
      }
      await file.write("\n]}\n");
      await file.close();
      file = undefined;
      await fs.rename(partial, output);
      return { path: output, bytes: (await fs.stat(output)).size };
    } finally {
      await file?.close();
      if (owned) await fs.rm(partial, { force: true });
      for (const key of pinned) {
        const count = this.readLeases.get(key)! - 1;
        if (count) this.readLeases.set(key, count);
        else this.readLeases.delete(key);
      }
      await this.prune();
    }
  }
  async list(includeUnavailable = false) {
    const rows: any[] = [];
    for (const f of await fs
      .readdir(this.directory)
      .catch(() => [] as string[]))
      if (f.endsWith(".json")) {
        try {
          rows.push(
            JSON.parse(await fs.readFile(path.join(this.directory, f), "utf8")),
          );
        } catch {}
      }
    return rows
      .filter((r) => includeUnavailable || r.available !== false)
      .sort((a, b) => b.stamp - a.stamp);
  }
  private prune() {
    const work = this.pruning.then(async () => {
      const rows = await this.list(true);
      let count = 0,
        bytes = 0;
      let tombstones = 0;
      for (const row of rows) {
        if (row.available === false) {
          if (++tombstones > 12)
            await fs.rm(path.join(this.directory, row.id + ".json"), {
              force: true,
            });
          continue;
        }
        const keep = count < 3 && bytes + row.bytes <= 100 * 2 ** 20;
        if (keep) {
          count++;
          bytes += row.bytes;
        }
        if (keep || this.readLeases.has(row.id)) continue;
        for (const suffix of ["", "-journal", "-wal", "-shm"])
          await fs.rm(this.db(row.id) + suffix, { force: true });
        await fs.writeFile(
          path.join(this.directory, row.id + ".json"),
          JSON.stringify({
            ...row,
            available: false,
            evictionReason:
              row.bytes > 100 * 2 ** 20
                ? "snapshot-over-budget"
                : count >= 3
                  ? "snapshot-count"
                  : "snapshot-budget",
            evictedAt: Date.now(),
          }),
        );
        tombstones++;
        if (tombstones > 12)
          await fs.rm(path.join(this.directory, row.id + ".json"), {
            force: true,
          });
      }
    });
    this.pruning = work.catch((error) =>
      this.profile.record("storage.retention", { error: String(error) }),
    );
    return this.pruning;
  }
  stats() {
    return { channels: this.channels.size, queries: this.readLeases.size };
  }
  abort() {
    for (const c of this.channels) c.abort();
  }
  async dispose(deadline?: number) {
    this.closed = true;
    await Promise.all([...this.channels].map((c) => c.dispose(deadline)));
    this.channels.clear();
    await this.pruning;
  }
}
