import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Ref } from "../shared/types";

export type WorkloadFile = Ref & {
  kind: "model" | "profile" | "log" | "artifact";
  label?: string;
};
export type WorkloadInput = {
  runId: string;
  endpoint: string;
  name?: string;
  phase?: string;
  step?: number;
  projectRef?: Ref;
  statusPath?: string;
  state?: "running" | "completed" | "failed" | "exited";
  process?: { pid: number; identity: string; bootId?: string };
  files?: WorkloadFile[];
};
export type Workload = WorkloadInput & {
  name: string;
  created: number;
  updated: number;
  producerStamp?: number;
  indexDigest?: string;
  progressAt?: number;
  lastObserved?: number;
  files: WorkloadFile[];
  observed?: "alive" | "exited" | "changed";
};
export type ProducerStatus = {
  runId: string;
  state?: WorkloadInput["state"];
  phase?: string;
  step?: number;
  updated: number;
};
export type IdentityReading = {
  reports?: Record<string, ProducerStatus>;
  status: string;
  stamp?: number;
  bootId?: string;
  identities?: Record<string, string | null>;
};

export type ObserveRuns = (
  endpoint: string,
  pids: number[],
  paths: string[],
) => Promise<IdentityReading>;

function connection(row: Workload, reading?: IdentityReading) {
  if (!reading || reading.status !== "online") return reading?.status;
  if (row.statusPath && reading.reports?.[row.statusPath]?.runId !== row.runId)
    return "unavailable";
  if (
    row.process &&
    !["exited", "changed"].includes(row.observed ?? "") &&
    reading.identities?.[row.process.pid] === undefined
  )
    return "unavailable";
  return "online";
}

export class Workloads {
  private ignored = new Set<string>();
  private rows = new Map<string, Workload>();
  private pending = Promise.resolve();
  constructor(
    private file: string,
    private validPath: (ref: Ref) => boolean,
    private sameMachine = (a: string, b: string) => a === b,
  ) {}
  private get ignoredFile() {
    return this.file + ".ignored";
  }
  async init() {
    const read = async (file: string, fallback: any) =>
      fs.readFile(file, "utf8").then(JSON.parse, (e) => {
        if (e.code === "ENOENT") return fallback;
        throw e;
      });
    const data = await read(this.file, []);
    const rows: Workload[] = Array.isArray(data) ? data : data.rows;
    this.ignored = new Set(await read(this.ignoredFile, data.ignored ?? []));
    this.rows = new Map(
      rows.filter((w) => !this.ignored.has(w.runId)).map((w) => [w.runId, w]),
    );
  }
  private async replace(file: string, value: unknown) {
    const tmp = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  private write(
    edit: (rows: Map<string, Workload>, ignored: Set<string>) => boolean,
  ) {
    const work = this.pending.then(async () => {
      const rows = new Map(this.rows),
        ignored = new Set(this.ignored);
      if (!edit(rows, ignored)) return;
      try {
        // Forget before removing the row; restore its contents before unforgetting.
        // The catalog itself retains the array format used by earlier versions.
        if (ignored.size > this.ignored.size)
          await this.replace(this.ignoredFile, [...ignored]);
        await this.replace(this.file, [...rows.values()]);
        if (ignored.size < this.ignored.size)
          await this.replace(this.ignoredFile, [...ignored]);
        this.rows = rows;
        this.ignored = ignored;
      } catch (e) {
        await this.init();
        throw e;
      }
    });
    this.pending = work.catch(() => {});
    return work;
  }
  has(runId: string) {
    return this.rows.has(runId);
  }
  durable() {
    return this.pending;
  }
  get(runId: string) {
    const row = this.rows.get(runId);
    if (!row) throw Error("作业未登记");
    return row;
  }
  async register(input: WorkloadInput) {
    await this.upsert(input);
    return this.get(input.runId);
  }
  async importRecord(input: WorkloadInput, digest: string) {
    if (
      this.ignored.has(input.runId) ||
      this.rows.get(input.runId)?.indexDigest === digest
    )
      return;
    await this.upsert(input, digest);
  }
  private async upsert(input: WorkloadInput, indexDigest?: string) {
    const { runId, endpoint, process: p, files = [] } = input;
    if (
      typeof runId !== "string" ||
      !runId.trim() ||
      runId.length > 256 ||
      typeof endpoint !== "string" ||
      !endpoint ||
      (input.name !== undefined &&
        (typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.length > 256)) ||
      (input.phase !== undefined &&
        (typeof input.phase !== "string" || input.phase.length > 256)) ||
      (input.state !== undefined &&
        !["running", "completed", "failed", "exited"].includes(input.state)) ||
      (input.step !== undefined &&
        (!Number.isSafeInteger(input.step) || input.step < 0)) ||
      (p &&
        (!Number.isSafeInteger(p.pid) ||
          p.pid <= 0 ||
          typeof p.identity !== "string" ||
          !p.identity.startsWith(p.pid + ":") ||
          p.identity.length > 160 ||
          (p.bootId !== undefined &&
            (typeof p.bootId !== "string" || p.bootId.length > 128)))) ||
      (input.statusPath !== undefined &&
        !this.validPath({ endpoint, path: input.statusPath })) ||
      !Array.isArray(files) ||
      files.some(
        (f) =>
          !f ||
          !["model", "profile", "log", "artifact"].includes(f.kind) ||
          !this.validPath(f) ||
          (f.label != null &&
            (typeof f.label !== "string" || f.label.length > 256)),
      )
    )
      throw Error("作业登记参数无效");
    if (
      input.projectRef &&
      (!this.sameMachine(input.projectRef.endpoint, endpoint) ||
        !this.validPath(input.projectRef))
    )
      throw Error("项目目录需位于作业端点");
    await this.write((rows, ignored) => {
      if (
        indexDigest &&
        (ignored.has(runId) || rows.get(runId)?.indexDigest === indexDigest)
      )
        return false;
      if (!indexDigest) ignored.delete(runId);
      const old = rows.get(runId),
        now = Date.now();
      if (
        indexDigest &&
        old?.projectRef &&
        input.projectRef &&
        (input.projectRef.endpoint !== old.projectRef.endpoint ||
          input.projectRef.path !== old.projectRef.path)
      )
        throw Error("运行编号已在另一个项目使用");
      if (old && old.endpoint !== endpoint)
        throw Error("运行编号已绑定其他端点");
      const merged = new Map(
        (old?.files ?? []).map((f) => [
          JSON.stringify([f.kind, f.endpoint, f.path]),
          f,
        ]),
      );
      for (const f of files)
        merged.set(JSON.stringify([f.kind, f.endpoint, f.path]), {
          kind: f.kind,
          endpoint: f.endpoint,
          path: f.path,
          label: f.label,
        });
      const row: Workload = {
        ...old,
        runId,
        endpoint,
        name: input.name ?? old?.name ?? runId,
        created: old?.created ?? now,
        updated: now,
        files: [...merged.values()],
      };
      if (
        input.statusPath !== undefined &&
        input.statusPath !== old?.statusPath
      ) {
        row.statusPath = input.statusPath;
        delete row.producerStamp;
      }
      if (indexDigest) row.indexDigest = indexDigest;
      if (
        (input.step !== undefined && input.step !== old?.step) ||
        (input.phase !== undefined && input.phase !== old?.phase)
      )
        row.progressAt = now;
      if (input.phase !== undefined) row.phase = input.phase;
      if (input.step !== undefined) row.step = input.step;
      if (input.state) row.state = input.state;
      if (p) {
        if (
          old?.process?.identity !== p.identity ||
          (p.bootId && p.bootId !== old?.process?.bootId)
        ) {
          delete row.observed;
          delete row.lastObserved;
        }
        row.process = {
          pid: p.pid,
          identity: p.identity,
          bootId:
            p.bootId ??
            (old?.process?.identity === p.identity
              ? old.process.bootId
              : undefined),
        };
      }
      if (input.projectRef)
        row.projectRef = {
          endpoint: input.projectRef.endpoint,
          path: input.projectRef.path,
        };
      rows.set(runId, row);
      return true;
    });
  }
  forget(runId: string) {
    return this.write((rows, ignored) => {
      if (!rows.delete(runId)) return false;
      ignored.add(runId);
      return true;
    });
  }
  async page(cursor: string | undefined, limit: number, observe?: ObserveRuns) {
    await this.pending;
    const band = (w: Workload) =>
      w.state === "failed"
        ? 1
        : ["completed", "exited"].includes(w.state ?? "") ||
            ["changed", "exited"].includes(w.observed ?? "")
          ? 2
          : 0;
    const all = [...this.rows.values()].sort(
      (a, b) =>
        band(a) - band(b) ||
        b.created - a.created ||
        a.runId.localeCompare(b.runId),
    );
    let start = 0;
    if (cursor) {
      const [group, stamp, id] = JSON.parse(cursor);
      start = all.findIndex(
        (w) =>
          band(w) > group ||
          (band(w) === group &&
            (w.created < stamp ||
              (w.created === stamp && w.runId.localeCompare(id) > 0))),
      );
      if (start < 0) start = all.length;
    }
    const page = all.slice(
      start,
      start + Math.max(1, Math.min(100, Math.floor(limit) || 30)),
    );
    const readings = await this.observe(page, observe);
    const last = page.at(-1);
    return {
      items: page.flatMap((w) => {
        const latest = this.rows.get(w.runId);
        if (!latest) return [];
        const { files, ...summary } = latest;
        return [
          {
            ...summary,
            fileCount: files.length,
            connection: connection(latest, readings.get(w.endpoint)),
          },
        ];
      }),
      cursor:
        start + page.length < all.length && last
          ? JSON.stringify([band(last), last.created, last.runId])
          : undefined,
      total: all.length,
    };
  }
  profiles() {
    const refs = new Map<
      string,
      { ref: Ref; label: string; project: string; runId: string }
    >();
    for (const row of this.rows.values())
      for (const f of row.files)
        if (f.kind === "profile") {
          const ref = { endpoint: f.endpoint, path: f.path };
          refs.set(JSON.stringify([ref.endpoint, ref.path]), {
            ref,
            label: f.label ?? row.name,
            project: row.projectRef?.path ?? row.endpoint,
            runId: row.runId,
          });
        }
    return [...refs.values()];
  }
  async surface(include: (row: Workload) => boolean, reader: ObserveRuns) {
    await this.pending;
    const rows = [...this.rows.values()].filter(include);
    const result = [];
    for (let i = 0; i < rows.length; i += 100) {
      const slice = rows.slice(i, i + 100),
        readings = await this.observe(slice, reader);
      for (const old of slice) {
        const row = this.rows.get(old.runId);
        if (!row) continue;
        const { files, statusPath, process, ...summary } = row;
        result.push({
          ...summary,
          connection: connection(row, readings.get(row.endpoint)),
        });
      }
    }
    return result;
  }
  async detail(runId: string, reader?: ObserveRuns) {
    await this.pending;
    const row = this.get(runId);
    const readings = await this.observe([row], reader);
    const latest = this.get(runId);
    return {
      ...latest,
      connection: connection(latest, readings.get(latest.endpoint)),
    };
  }

  private async observe(page: Workload[], observe?: ObserveRuns) {
    const readings = new Map<string, IdentityReading>();
    if (observe) {
      const groups = new Map<
        string,
        { ids: Set<number>; paths: Set<string> }
      >();
      for (const w of page) {
        if (["failed", "completed", "exited"].includes(w.state ?? "")) continue;
        const processActive =
          w.process && !["exited", "changed"].includes(w.observed ?? "");
        if (!processActive && !w.statusPath) continue;
        const g = groups.get(w.endpoint) ?? {
          ids: new Set<number>(),
          paths: new Set<string>(),
        };
        if (processActive) g.ids.add(w.process!.pid);
        if (w.statusPath) g.paths.add(w.statusPath);
        groups.set(w.endpoint, g);
      }
      await Promise.all(
        [...groups].map(async ([ep, g]) => {
          try {
            readings.set(
              ep,
              await observe(
                ep,
                [...g.ids].sort((a, b) => a - b),
                [...g.paths].sort(),
              ),
            );
          } catch {
            readings.set(ep, { status: "offline" });
          }
        }),
      );
      if (readings.size)
        await this.write((rows) => {
          let changed = false;
          for (const w of page) {
            const s = readings.get(w.endpoint),
              p = w.process;
            let latest = rows.get(w.runId);
            if (!latest || latest !== w || s?.status !== "online") continue;
            const report = latest.statusPath
              ? s.reports?.[latest.statusPath]
              : undefined;
            if (
              report?.runId === latest.runId &&
              Number.isSafeInteger(report.updated) &&
              report.updated > (latest.producerStamp ?? 0)
            ) {
              latest = {
                ...latest,
                producerStamp: report.updated,
                progressAt:
                  (report.step !== undefined && report.step !== latest.step) ||
                  (report.phase !== undefined && report.phase !== latest.phase)
                    ? report.updated
                    : latest.progressAt,
                updated: Math.max(latest.updated, report.updated),
                phase: report.phase ?? latest.phase,
                step: report.step ?? latest.step,
                state: report.state ?? latest.state,
              };
              rows.set(w.runId, latest);
              changed = true;
            }
            if (
              !p ||
              latest.process?.identity !== p.identity ||
              ["completed", "failed", "exited"].includes(latest.state ?? "") ||
              ["changed", "exited"].includes(latest.observed ?? "") ||
              !s.identities ||
              !(p.pid in s.identities)
            )
              continue;
            const value = s.identities[p.pid];
            const observed =
              p.bootId && s.bootId && p.bootId !== s.bootId
                ? "changed"
                : value === null
                  ? "exited"
                  : value === p.identity
                    ? "alive"
                    : "changed";
            const stamp = s.stamp ?? Date.now();
            if (stamp < (latest.lastObserved ?? 0)) continue;
            if (
              latest.observed !== observed ||
              stamp - (latest.lastObserved ?? 0) >= 60000
            ) {
              rows.set(w.runId, {
                ...latest,
                observed,
                process: { ...p, bootId: p.bootId ?? s.bootId },
                lastObserved: stamp,
                updated: latest.observed !== observed ? stamp : latest.updated,
              });
              changed = true;
            }
          }
          return changed;
        });
    }
    return readings;
  }
}
