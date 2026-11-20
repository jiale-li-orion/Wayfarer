import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SystemMonitor } from "./monitor";
import type { StorageAnalysis } from "./storage";
import type { Endpoints } from "../adapters/registry";
import type { Entry, Ref, Job } from "../shared/types";
import { pathApi, assertName } from "../shared/paths";
import type { JobContext } from "./jobs";
import { csvRows, csvHeader, compactResourceSnapshot } from "./resourceExport";

const fields = [
  "stamp",
  "endpoint",
  "section",
  "cpuPercent",
  "memoryAvailable",
  "commitUsed",
  "commitLimit",
  "swapUsed",
  "wslBudget",
  "gpus",
] as const;
type Selection = {
  fields?: string[];
  id: string;
  cursor?: number;
  limit?: number;
  from?: number;
  to?: number;
  endpoint?: string;
};
export class AgentRecords {
  constructor(
    private monitor: SystemMonitor,
    private storage: StorageAnalysis,
    private endpoints: Endpoints,
    private directory: string,
  ) {}
  private locations() {
    return [
      ...new Set([
        this.monitor.recordingDirectory(),
        path.join(this.directory, "resource-recordings"),
      ]),
    ];
  }
  private async locate(id: string) {
    if (typeof id !== "string" || !/^\d+-[a-f\d-]{36}\.jsonl$/i.test(id))
      throw Error("未知录制编号");
    for (const dir of this.locations()) {
      const file = path.join(dir, id);
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile()) return { file, size: stat.size };
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    throw Error("录制文件不存在");
  }
  async control(
    action: string,
    options: { durationMs?: number; cursor?: string; limit?: number } = {},
  ) {
    if (action === "list") {
      const ids = new Set<string>();
      for (const dir of this.locations()) {
        try {
          for (const file of await fs.readdir(dir, { withFileTypes: true }))
            if (file.isFile() && /^\d+-[a-f\d-]{36}\.jsonl$/i.test(file.name))
              ids.add(file.name);
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      const sorted = [...ids]
        .filter((id) => !options.cursor || id < options.cursor)
        .sort()
        .reverse();
      const records = sorted.slice(
        0,
        Math.min(100, Math.max(1, options.limit ?? 50)),
      );
      return {
        recordings: records,
        cursor: records.length < sorted.length ? records.at(-1) : undefined,
        active:
          (await this.monitor.snapshot()).recording?.file
            ?.split(/[\\/]/)
            .pop() ?? null,
      };
    }
    if (action !== "start" && action !== "stop") throw Error("未知录制操作");
    const rec =
      action === "start"
        ? await this.monitor.startRecording(options.durationMs)
        : await this.monitor.stopRecording();
    return rec
      ? {
          id: path.basename(rec.file),
          started: rec.started,
          deadline: rec.deadline,
          count: rec.count,
          bytes: rec.bytes,
          active: action === "start",
        }
      : { active: false };
  }
  async page(a: Selection, raw = false, end?: number) {
    const { file, size } = await this.locate(a.id),
      offset = a.cursor ?? 0,
      limit = Math.min(a.limit ?? 30, 100);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > size ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      (a.from != null && !Number.isFinite(a.from)) ||
      (a.to != null && !Number.isFinite(a.to)) ||
      (a.from != null && a.to != null && a.from > a.to)
    )
      throw Error("无效的录制读取范围");
    const fence = Math.min(size, end ?? size),
      items: any[] = [];
    let cursor = offset,
      bytes = 0;
    if (offset === fence) return { items, cursor, size: fence, hasMore: false };
    if (
      a.fields &&
      (!Array.isArray(a.fields) ||
        a.fields.some((k) => !fields.includes(k as (typeof fields)[number])))
    )
      throw Error("未知的录制字段");
    const input = await this.monitor.readRecording(file, offset, fence);
    try {
      for await (const line of input.lines) {
        const length = Buffer.byteLength(line) + 1;
        if (cursor + length > fence) break;
        if (line) {
          const s = JSON.parse(line);
          if (
            (!a.endpoint || s.endpoint === a.endpoint) &&
            (a.from == null || s.stamp >= a.from) &&
            (a.to == null || s.stamp <= a.to)
          ) {
            const flat: Record<string, unknown> = {
              stamp: s.stamp,
              endpoint: s.endpoint,
              section: s.section,
              cpuPercent: s.system?.cpuPercent,
              memoryAvailable: s.system?.memory?.available,
              commitUsed: s.system?.memory?.commitUsed,
              commitLimit: s.system?.memory?.commitLimit,
              swapUsed: s.system?.memory?.swapUsed,
              wslBudget: s.wslBudget,
              gpus: s.gpus,
            };
            const v = raw
                ? s
                : a.fields?.length
                  ? Object.fromEntries(a.fields.map((k) => [k, flat[k]]))
                  : compactResourceSnapshot(s),
              n = Buffer.byteLength(JSON.stringify(v));
            if (items.length && bytes + n > 262144) break;
            items.push(v);
            bytes += n;
          }
        }
        cursor += length;
        if (items.length === limit || cursor - offset >= 1048576) break;
      }
    } finally {
      input.lines.close();
      input.stream.destroy();
    }
    return {
      items,
      cursor,
      size: fence,
      hasMore: cursor > offset && cursor < fence,
    };
  }
  async cleanup(job: Job) {
    const receipt = job.checkpoint.exportTemp;
    if (!receipt) return;
    const ep = this.endpoints.get(receipt.ref.endpoint);
    try {
      const current = await ep.call<Entry>("stat", { path: receipt.ref.path });
      if (
        current.kind !== "file" ||
        !receipt.identity ||
        current.identity !== receipt.identity
      )
        throw Error("导出暂存文件身份已变化");
      await ep.call("remove", { path: receipt.ref.path, expected: current });
    } catch (e: any) {
      if (![2, "ENOENT"].includes(e.code) && e.type !== "FileNotFoundError")
        throw e;
    }
    delete job.checkpoint.exportTemp;
    job.cleanupPending = [];
  }
  async export(ctx: JobContext) {
    const { source, format = "json", target } = ctx.job.input;
    const ep = this.endpoints.get(target.endpoint),
      api = pathApi(ep.config);
    if (!api.isAbsolute(target.path) || !api.basename(target.path))
      throw Error("导出需要目标文件的绝对路径");
    const prior = ctx.job.checkpoint.exportTemp;
    if (prior?.sha256 && prior.identity) {
      const completed = await ep
        .call<Entry>("stat", { path: target.path })
        .catch(() => undefined);
      if (
        completed &&
        completed.identity === prior.identity &&
        (await ep.call("hash", { path: target.path })) === prior.sha256
      ) {
        await this.cleanup(ctx.job);
        return { ref: target, bytes: completed.size, sha256: prior.sha256 };
      }
    }
    await this.cleanup(ctx.job);
    assertName(ep.config, api.basename(target.path));
    const temporary = path.join(this.directory, "export-staging", ctx.job.id);
    await fs.mkdir(temporary, { recursive: true });
    const local = path.join(temporary, "payload");
    await fs.rm(local, { force: true });
    const partial = api.join(
      api.dirname(target.path),
      ".wayfarer-export-" + randomUUID() + ".part",
    );
    let owned = false;
    try {
      if (source.kind === "storage") {
        if (format !== "json") throw Error("存储分析导出为 JSON");
        await this.storage.exportTo(source.id, local, source.before, ctx.check);
      } else {
        const f = await fs.open(local, "wx", 0o600);
        try {
          await f.write(format === "csv" ? csvHeader : "[");
          let first = true;
          const append = async (s: any) => {
            ctx.check();
            await f.write(
              format === "csv"
                ? csvRows(s)
                : (first ? "" : ",") + JSON.stringify(s),
            );
            first = false;
          };
          if (source.kind === "recording") {
            let cursor = 0;
            const fence = (await this.locate(source.id)).size;
            while (cursor < fence) {
              ctx.check();
              const p = await this.page({ ...source, cursor }, true, fence);
              for (const s of p.items) await append(s);
              if (!p.hasMore) break;
              cursor = p.cursor;
            }
          } else if (source.kind === "resources") {
            if (source.query?.endpoint)
              await append(await this.monitor.snapshot(source.query));
            else
              for (const m of this.monitor.machines())
                await append(
                  await this.monitor.snapshot({
                    endpoint: m.endpoint,
                    section: "summary",
                  }),
                );
          } else throw Error("未知导出来源");
          if (format !== "csv") await f.write("]");
        } finally {
          await f.close();
        }
      }
      ctx.check();
      ctx.job.checkpoint.exportTemp = {
        ref: { endpoint: target.endpoint, path: partial },
      };
      await ctx.save();
      try {
        await ep.call("write", { path: partial, exclusive: true, data: "" });
        owned = true;
      } catch (e: any) {
        if (e.code === "EEXIST" || e.type === "FileExistsError")
          delete ctx.job.checkpoint.exportTemp;
        throw e;
      }
      const st = await ep.call<Entry>("stat", { path: partial });
      ctx.job.checkpoint.exportTemp = {
        ref: { endpoint: target.endpoint, path: partial },
        identity: st.identity,
      };
      await ctx.save();
      const f = await fs.open(local, "r"),
        hash = createHash("sha256");
      let offset = 0;
      try {
        const b = Buffer.allocUnsafe(256 * 1024);
        for (;;) {
          ctx.check();
          const { bytesRead: n } = await f.read(b, 0, b.length, offset);
          if (!n) break;
          const chunk = b.subarray(0, n);
          hash.update(chunk);
          const wrote = await ep.call<number>("write", {
            path: partial,
            offset,
            data: chunk.toString("base64"),
          });
          if (wrote !== n) throw Error("导出写入不完整");
          offset += n;
          ctx.progress({ bytes: offset, progress: "写入导出文件" });
        }
      } finally {
        await f.close();
      }
      const sha256 = hash.digest("hex");
      if ((await ep.call("hash", { path: partial })) !== sha256)
        throw Error("导出文件摘要不匹配");
      ctx.job.checkpoint.exportTemp = {
        ...ctx.job.checkpoint.exportTemp,
        sha256,
      };
      await ctx.save();
      ctx.check();
      await ep.call("publishNewFile", { path: partial, dest: target.path });
      return { ref: target as Ref, bytes: offset, sha256 };
    } finally {
      try {
        if (owned) {
          try {
            await this.cleanup(ctx.job);
          } catch (e) {
            ctx.job.cleanupPending = [
              { endpoint: target.endpoint, path: partial, error: String(e) },
            ];
            throw e;
          }
        }
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
  }
}
