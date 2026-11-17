import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Job } from "../shared/types";
import { Profiler } from "./log";
export class Stopped extends Error {
  constructor(public state: "paused" | "cancelled") {
    super(state);
  }
}
export interface JobContext {
  job: Job;
  check: () => void;
  progress: (fields: Partial<Job>) => void;
  log: (s: string) => void;
  save: () => Promise<void>;
  touch: (key: string) => void;
}
type Runner = (ctx: JobContext) => Promise<any>;
export class Jobs extends EventEmitter {
  readonly records = new Map<string, Job>();
  private runners = new Map<string, Runner>();
  private running = new Set<string>();
  private requests = new Map<string, "paused" | "cancelled">();
  private held = new Map<string, string[]>();
  private locks = new Map<string, string[]>();
  private writes = Promise.resolve();
  private timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private get historyDir() {
    return path.join(this.dir, "history");
  }
  private historyCount = 0;
  private readonly recentLimit = 100;
  private terminal(j: Pick<Job, "state">) {
    return j.state === "completed" || j.state === "cancelled";
  }
  private archiveName(j: Pick<Job, "created" | "id">) {
    return String(j.created).padStart(16, "0") + "-" + j.id + ".json";
  }
  private trimHistory() {
    const recent = [...this.records.values()]
      .filter((j) => this.terminal(j))
      .sort((a, b) => b.updated - a.updated);
    for (const j of recent.slice(this.recentLimit)) {
      this.records.delete(j.id);
      this.locks.delete(j.id);
      this.dirty.delete(j.id);
      this.inputs.delete(j.id);
    }
  }
  private dirty = new Map<string, Set<string>>();
  private inputs = new Set<string>();
  constructor(
    private dir: string,
    private profile: Profiler,
    private transferLimit = 2,
  ) {
    super();
  }
  register(kind: string, runner: Runner) {
    this.runners.set(kind, runner);
  }
  async init() {
    await fs.mkdir(this.historyDir, { recursive: true, mode: 0o700 });
    for await (const entry of await fs.opendir(this.historyDir))
      if (entry.name.endsWith(".json")) this.historyCount++;
    for (const f of await fs.readdir(this.dir)) {
      if (
        !f.endsWith(".json") ||
        f.endsWith(".input.json") ||
        f.endsWith(".result.json")
      )
        continue;
      try {
        const j: Job = JSON.parse(
          await fs.readFile(path.join(this.dir, f), "utf8"),
        );
        const version = (j as any).journalVersion;
        if (this.terminal(j)) {
          // Legacy journals keep their payload and remain readable by id.
          await fs.rename(
            path.join(this.dir, f),
            path.join(this.historyDir, this.archiveName(j)),
          );
          this.historyCount++;
          continue;
        }
        if (version === 2) {
          if (j.state !== "completed")
            j.input = JSON.parse(
              await fs.readFile(
                path.join(this.dir, j.id + ".input.json"),
                "utf8",
              ),
            );
          this.inputs.add(j.id);
          j.checkpoint = {};
          if (j.state !== "completed") {
            const journal = path.join(this.dir, j.id + ".checkpoint.jsonl");
            if (
              await fs.stat(journal).then(
                () => true,
                () => false,
              )
            ) {
              for await (const line of createInterface({
                input: createReadStream(journal),
                crlfDelay: Infinity,
              })) {
                try {
                  const update = JSON.parse(line);
                  if (update.deleted) delete j.checkpoint[update.key];
                  else j.checkpoint[update.key] = update.value;
                } catch (error) {
                  this.profile.record("journal.partial", {
                    job: j.id,
                    error: String(error),
                  });
                }
              }
            }
          }
        }
        this.track(j, version !== 2);
        if (["queued", "running"].includes(j.state)) {
          j.state = "paused";
          j.progress = "窗口已关闭，可继续";
        }
        if (j.state === "completed") {
          j.input = undefined;
          j.result = undefined;
          j.logs = [];
        }
        this.records.set(j.id, j);
        this.locks.set(j.id, j.checkpoint.locks ?? []);
      } catch (e) {
        this.profile.record("journal.read", { file: f, error: String(e) });
      }
    }
  }
  submit(kind: string, input: any, locks: string[] = []): Job {
    if (this.closed) throw Error("Session is closing");
    if (!this.runners.has(kind)) throw Error("Unknown task kind");
    const now = Date.now();
    const j: Job = {
      id: randomUUID(),
      kind,
      state: "queued",
      created: now,
      updated: now,
      bytes: 0,
      files: 0,
      input,
      logs: [],
      checkpoint: { locks },
    };
    this.track(j, true);
    this.records.set(j.id, j);
    this.locks.set(j.id, locks);
    void this.save(j).then(
      () => this.pump(),
      (error) => {
        j.state = "failed";
        j.error = "Task journal: " + String(error);
        this.emit("change", j);
      },
    );
    this.emit("change", j);
    return j;
  }
  private track(j: Job, initial: boolean) {
    const changed = new Set<string>(initial ? Object.keys(j.checkpoint) : []);
    this.dirty.set(j.id, changed);
    j.checkpoint = new Proxy(j.checkpoint, {
      set(target, key, value) {
        changed.add(String(key));
        return Reflect.set(target, key, value);
      },
      deleteProperty(target, key) {
        changed.add(String(key));
        return Reflect.deleteProperty(target, key);
      },
    });
  }
  get(id: string) {
    const j = this.records.get(id);
    if (!j) throw Error("Unknown task");
    return j;
  }
  summary(j: Job) {
    const { checkpoint, input, result, logs, ...summary } = j;
    return summary;
  }
  stats() {
    const states: Record<string, number> = {};
    for (const j of this.records.values())
      states[j.state] = (states[j.state] ?? 0) + 1;
    return {
      records: this.records.size,
      historyOnDisk: this.historyCount,
      retainedTerminal: [...this.records.values()].filter((j) =>
        this.terminal(j),
      ).length,
      running: this.running.size,
      heldLocks: this.held.size,
      progressTimers: this.timers.size,
      states,
    };
  }
  list() {
    return [...this.records.values()]
      .sort((a, b) => b.created - a.created)
      .map((j) => this.summary(j));
  }
  busyCount() {
    let count = 0;
    for (const j of this.records.values())
      if (j.state === "running" || j.state === "queued") count++;
    return count;
  }
  active() {
    return this.list().filter((j) => !this.terminal(j));
  }
  /** Cursor is an immutable created/id key. Concurrent completions cannot shift a page. */
  async page(cursor?: string, limit = 50) {
    limit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    await this.writes;
    const names: string[] = [];
    for await (const entry of await fs.opendir(this.historyDir)) {
      if (!entry.name.endsWith(".json") || (cursor && entry.name >= cursor))
        continue;
      names.push(entry.name);
      names.sort((a, b) => b.localeCompare(a));
      if (names.length > limit + 1) names.pop();
    }
    const hasMore = names.length > limit;
    const chosen = names.slice(0, limit);
    const history = [];
    for (const name of chosen) {
      try {
        history.push(
          this.summary(
            JSON.parse(
              await fs.readFile(path.join(this.historyDir, name), "utf8"),
            ),
          ),
        );
      } catch (error) {
        this.profile.record("journal.read", {
          file: name,
          error: String(error),
        });
      }
    }
    return {
      active: this.active(),
      history,
      cursor: hasMore ? chosen.at(-1) : undefined,
      total: this.historyCount,
    };
  }
  private async stored(id: string) {
    if (!id || path.basename(id) !== id || id.includes("\\"))
      throw Error("Invalid task id");
    const current = await fs
      .readFile(path.join(this.dir, id + ".json"), "utf8")
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
    if (current) return JSON.parse(current);
    for await (const entry of await fs.opendir(this.historyDir)) {
      if (entry.name.endsWith("-" + id + ".json"))
        return JSON.parse(
          await fs.readFile(path.join(this.historyDir, entry.name), "utf8"),
        );
    }
    throw Error("Unknown task");
  }
  private detailPage(j: Job, offset: number, limit: number) {
    const { checkpoint, ...detail } = j;
    let result = j.result;
    const entries = Array.isArray(result) ? result : result?.entries;
    if (Array.isArray(entries))
      result = {
        ...(Array.isArray(result) ? {} : result),
        entries: entries.slice(offset, offset + limit),
        offset,
        total: entries.length,
        hasMore: offset + limit < entries.length,
      };
    return {
      ...detail,
      result,
      checkpointFile: path.join(this.dir, j.id + ".checkpoint.jsonl"),
      resultFile: path.join(this.dir, j.id + ".result.json"),
    };
  }
  async details(id: string, offset = 0, limit = 200) {
    offset = Math.max(0, Math.floor(offset));
    limit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const j = this.records.get(id);
    if (j && !this.terminal(j)) return this.detailPage(j, offset, limit);
    try {
      await this.writes;
    } catch {
      if (j) return this.detailPage(j, offset, limit);
      throw Error("Task journal write failed");
    }
    const stored = await this.stored(id);
    const payload = await fs
      .readFile(path.join(this.dir, id + ".result.json"), "utf8")
      .then(JSON.parse, () => ({
        result: stored.result,
        logs: stored.logs ?? [],
      }));
    const input = await fs
      .readFile(path.join(this.dir, id + ".input.json"), "utf8")
      .then(JSON.parse, () => stored.input);
    return this.detailPage(
      { ...stored, ...payload, input, checkpoint: {} },
      offset,
      limit,
    );
  }
  control(id: string, action: "pause" | "resume" | "cancel") {
    const j = this.get(id);
    if (j.kind === "package" && action === "pause")
      throw Error("包管理器支持取消；管理器执行状态会保留。");
    if (action === "resume") {
      if (!["paused", "failed"].includes(j.state))
        throw Error("Task is not resumable");
      if (j.kind === "package" && j.checkpoint.process)
        throw Error(
          "Package manager process state must be checked; submit a new command",
        );
      j.state = "queued";
      j.error = undefined;
      this.requests.delete(id);
    } else {
      const state = action === "pause" ? "paused" : "cancelled";
      if (["completed", "cancelled"].includes(j.state)) return j;
      if (this.running.has(id)) this.requests.set(id, state);
      else j.state = state;
    }
    void this.save(j)
      .then(() => this.trimHistory())
      .catch((error) =>
        this.profile.record("journal.write", {
          job: j.id,
          error: String(error),
        }),
      );
    this.emit("change", j);
    this.pump();
    return j;
  }
  private conflict(keys: string[]) {
    for (const existing of this.held.values())
      for (const a of keys)
        for (const b of existing)
          if (
            a === b ||
            a.startsWith(b.replace(/\/$/, "") + "/") ||
            b.startsWith(a.replace(/\/$/, "") + "/")
          )
            return true;
    return false;
  }
  private pump() {
    if (this.closed) return;
    for (const j of this.records.values()) {
      if (j.state !== "queued") continue;
      const n = [...this.running].filter(
        (id) => this.get(id).kind === j.kind,
      ).length;
      if (
        n >= (j.kind === "transfer" ? this.transferLimit : 2) ||
        this.conflict(this.locks.get(j.id) ?? [])
      )
        continue;
      this.running.add(j.id);
      this.held.set(j.id, this.locks.get(j.id) ?? []);
      void this.run(j);
    }
  }
  private async run(j: Job) {
    j.state = "running";
    j.updated = Date.now();
    this.profile.record("job.start", {
      job: j.id,
      kind: j.kind,
      queueMs: j.updated - j.created,
    });
    this.emit("change", j);
    const start = performance.now();
    const ctx: JobContext = {
      job: j,
      check: () => {
        const s = this.requests.get(j.id);
        if (s) throw new Stopped(s);
        if (this.closed) throw new Stopped("paused");
      },
      progress: (fields) => {
        Object.assign(j, fields);
        j.updated = Date.now();
        this.schedule(j);
      },
      log: (s) => {
        void fs
          .appendFile(path.join(this.dir, j.id + ".log"), s + "\n", {
            mode: 0o600,
          })
          .catch((error) =>
            this.profile.record("job.log.write", {
              job: j.id,
              error: String(error),
            }),
          );
        j.logs.push(s.slice(-16384));
        while (j.logs.join("").length > 32768) j.logs.shift();
        this.profile.record("job.output", { job: j.id, text: s.slice(-8192) });
        this.schedule(j);
      },
      touch: (key) => this.dirty.get(j.id)?.add(key),
      save: () => this.save(j),
    };
    try {
      j.result = await this.runners.get(j.kind)!(ctx);
      j.state = "completed";
      j.checkpoint = { locks: j.checkpoint.locks };
    } catch (e) {
      if (e instanceof Stopped || this.closed || this.requests.has(j.id)) {
        j.state =
          e instanceof Stopped
            ? e.state
            : (this.requests.get(j.id) ?? "paused");
      } else {
        j.state = "failed";
        j.error = String(e);
      }
    } finally {
      clearTimeout(this.timers.get(j.id));
      this.timers.delete(j.id);
      j.updated = Date.now();
      this.requests.delete(j.id);
      this.running.delete(j.id);
      this.held.delete(j.id);
      let stored = true;
      await this.save(j).catch((error) => {
        stored = false;
        j.error = "任务记录写入失败：" + String(error);
        this.profile.record("journal.write", {
          job: j.id,
          error: String(error),
        });
      });
      if (this.terminal(j) && stored) {
        j.result = undefined;
        j.input = undefined;
        j.logs = [];
      }
      this.emit("change", j);
      this.profile.record("job.end", {
        job: j.id,
        kind: j.kind,
        state: j.state,
        ms: performance.now() - start,
        bytes: j.bytes,
        MiBps: j.bytes / 1048576 / ((performance.now() - start) / 1000),
        error: j.error,
      });
      this.trimHistory();
      this.pump();
    }
  }
  private schedule(j: Job) {
    if (this.timers.has(j.id)) return;
    this.timers.set(
      j.id,
      setTimeout(() => {
        this.timers.delete(j.id);
        this.emit("change", j);
        void this.save(j).catch((error) =>
          this.profile.record("journal.write", {
            job: j.id,
            error: String(error),
          }),
        );
      }, 200),
    );
  }
  private save(j: Job) {
    const { input, checkpoint, result, logs, ...metadata } = j;
    const completed = this.terminal(metadata);
    const payload = completed ? JSON.stringify({ result, logs }) : undefined;
    const data = JSON.stringify({
      ...metadata,
      ...(!completed ? { result, logs } : {}),
      journalVersion: 2,
    });
    const dirty = this.dirty.get(j.id) ?? new Set<string>();
    const changes = [...dirty]
      .map((key) =>
        JSON.stringify({
          key,
          value: checkpoint[key],
          deleted: !(key in checkpoint),
        }),
      )
      .join("\n");
    dirty.clear();
    const file = completed
        ? path.join(this.historyDir, this.archiveName(j))
        : path.join(this.dir, j.id + ".json"),
      journal = path.join(this.dir, j.id + ".checkpoint.jsonl");
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        if (!this.inputs.has(j.id)) {
          await fs.writeFile(
            path.join(this.dir, j.id + ".input.json"),
            JSON.stringify(input),
            { mode: 0o600 },
          );
          this.inputs.add(j.id);
        }
        if (changes && !completed)
          await fs.appendFile(journal, changes + "\n", { mode: 0o600 });
        if (payload !== undefined)
          await fs.writeFile(
            path.join(this.dir, j.id + ".result.json"),
            payload,
            { mode: 0o600 },
          );
        await fs.writeFile(file + ".tmp", data, { mode: 0o600 });
        await fs.rename(file + ".tmp", file);
        if (completed) {
          const previous = await fs
            .stat(path.join(this.dir, j.id + ".json"))
            .catch(() => undefined);
          await fs.rm(path.join(this.dir, j.id + ".json"), { force: true });
          if (previous) this.historyCount++;
          await fs.rm(journal, { force: true });
          this.dirty.delete(j.id);
          this.inputs.delete(j.id);
        }
      });
    return this.writes;
  }
  async dispose() {
    this.closed = true;
    for (const id of this.running) this.requests.set(id, "paused");
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const j of this.records.values())
      if (["running", "queued"].includes(j.state)) {
        j.state = "paused";
        await this.save(j);
      }
    await this.writes;
  }
}
