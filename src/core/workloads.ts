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
  private rows = new Map<string, Workload>();
  private pending = Promise.resolve();
  constructor(
    private file: string,
    private validPath: (ref: Ref) => boolean,
  ) {}
  async init() {
    try {
      const data: Workload[] = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.rows = new Map(data.map((w) => [w.runId, w]));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  private write(edit: (rows: Map<string, Workload>) => boolean) {
    const work = this.pending.then(async () => {
      const rows = new Map(this.rows);
      if (!edit(rows)) return;
      const tmp = this.file + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, JSON.stringify([...rows.values()]), {
          mode: 0o600,
        });
        await fs.rename(tmp, this.file);
        this.rows = rows;
      } finally {
        await fs.rm(tmp, { force: true });
      }
    });
    this.pending = work.catch(() => {});
    return work;
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
    await this.write((rows) => {
      const old = rows.get(runId),
        now = Date.now();
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
      rows.set(runId, row);
      return true;
    });
    return this.get(runId);
  }
  forget(runId: string) {
    return this.write((rows) => rows.delete(runId));
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
