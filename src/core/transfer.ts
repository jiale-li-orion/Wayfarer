import { createHash } from "node:crypto";
import type { Endpoints } from "../adapters/registry";
import type { Endpoint, Entry, Ref, Job } from "../shared/types";
import { alias, assertName, changed, contains, pathApi } from "../shared/paths";
import type { JobContext } from "./jobs";
import { TransferTiming } from "./transferTiming";
import type { OperationsStore } from "./operations";
import type { PeerTransfer } from "./peerTransfer";
export interface TransferInput {
  sources: Ref[];
  target: Ref;
  mode: "copy" | "move";
  conflict: "skip" | "rename" | "overwrite";
  transport?: "auto" | "relay";
}
type BufferLease = { buffer: Buffer; release(): void };
type AcquireBuffer = () => Promise<BufferLease>;
type FileProgress = {
  source: Entry;
  dest: string;
  partial: string;
  offset: number;
  committed?: boolean;
  removed?: boolean;
  digest?: string;
  peer?: boolean;
};
async function maybe(e: Endpoint, p: string) {
  try {
    return await e.call<Entry>("stat", { path: p });
  } catch (x: any) {
    if (["ENOENT", 2].includes(x.code) || x.type === "FileNotFoundError")
      return undefined;
    throw x;
  }
}
export class Transfers {
  private leases = 0;
  private buffers = 0;
  private bufferBytes = 0;
  private timings = new WeakMap<Job, TransferTiming>();
  private route = new WeakMap<Job, { directBytes: number; relayBytes: number; readMs: number; writeMs: number; syncMs: number; cpuMs: number; encodingMs: number; reasons: string[] }>();
  stats() {
    return {
      leases: this.leases,
      buffers: this.buffers,
      bufferBytes: this.bufferBytes,
    };
  }

  constructor(
    private endpoints: Endpoints,
    private invalidate: (r: Ref) => void,
    private operations?: OperationsStore,
    private peer?: PeerTransfer,
    private sameSharedPath?: (source: Ref, target: Ref) => boolean,
  ) {}
  async cleanup(job: Job) {
    const registered =
      job.cleanupPending ??
      Object.values(job.checkpoint)
        .filter((v: any) => v?.partial && !v.committed)
        .map((v: any) => ({
          endpoint: job.input.target.endpoint,
          path: v.partial,
        }));
    const remaining: NonNullable<Job["cleanupPending"]> = [];
    for (const item of registered) {
      try {
        const endpoint = this.endpoints.get(item.endpoint);
        const paths = pathApi(endpoint.config);
        if (
          !paths
            .basename(item.path)
            .startsWith(".workspace-map-" + job.id + "-")
        )
          throw Error("Temporary file ownership mismatch");
        const entry = await maybe(endpoint, item.path);
        if (entry)
          await endpoint.call("remove", { path: item.path, expected: entry });
      } catch (error) {
        remaining.push({ ...item, error: String(error) });
      }
    }
    job.cleanupPending = remaining;
  }
  async run(ctx: JobContext) {
    const input = ctx.job.input as TransferInput;
    const directMove =
      input.mode === "move" &&
      input.sources.every((s) => s.endpoint === input.target.endpoint);
    const scopes = new Map<string, { endpoint: Endpoint; release(): void }>();
    const get = (id: string) => {
      let scope = scopes.get(id);
      if (!scope) {
        const endpoint = this.endpoints.get(id);
        scope =
          !directMove && endpoint.openTransfer
            ? endpoint.openTransfer()
            : { endpoint, release() {} };
        scopes.set(id, scope);
        this.leases++;
      }
      return scope.endpoint;
    };
    const timing = new TransferTiming();
    this.timings.set(ctx.job, timing);
    const route = { directBytes: 0, relayBytes: 0, readMs: 0, writeMs: 0, syncMs: 0,
      cpuMs: 0, encodingMs: 0, reasons: [], ...ctx.job.result?.transport };
    this.route.set(ctx.job, route);
    ctx.job.result = { ...ctx.job.result, transport: route };
    let outcome: Awaited<ReturnType<Transfers["perform"]>> | undefined;
    try {
      outcome = await this.perform(ctx, get);
    } finally {
      this.timings.delete(ctx.job);
      this.route.delete(ctx.job);
      const previous = ctx.job.result?.timing;
      ctx.job.result = { ...(outcome ?? ctx.job.result), timing: timing.finish(previous), transport: route };
      for (const scope of scopes.values()) {
        scope.release();
        this.leases--;
      }
    }
    return ctx.job.result;
  }
  private async perform(ctx: JobContext, get: (id: string) => Endpoint) {
    const input = ctx.job.input as TransferInput;
    const dest = get(input.target.endpoint);
    const dpath = pathApi(dest.config);
    const target = await dest.call<Entry>("stat", { path: input.target.path });
    if (target.kind !== "directory") throw Error("Target must be a directory");
    let skipped = 0;
    const free: Buffer[] = [];
    const waiting: ((buffer: Buffer) => void)[] = [];
    let allocated = 0;
    const acquireBuffer: AcquireBuffer = async () => {
      let buffer = free.pop();
      if (!buffer && allocated < 4) {
        allocated++;
        buffer = Buffer.allocUnsafe(1048576);
      }
      if (!buffer)
        buffer = await new Promise<Buffer>((resolve) => waiting.push(resolve));
      this.buffers++;
      this.bufferBytes += buffer.length;
      let released = false;
      return {
        buffer,
        release: () => {
          if (released) return;
          released = true;
          this.buffers--;
          this.bufferBytes -= buffer!.length;
          const next = waiting.shift();
          if (next) next(buffer!);
          else free.push(buffer!);
        },
      };
    };
    for (const source of input.sources) {
      ctx.check();
      const itemKey = source.endpoint + ":" + source.path;
      if (ctx.job.checkpoint["done:" + itemKey]) continue;
      const src = get(source.endpoint);
      const spath = pathApi(src.config);
      const name = spath.basename(source.path);
      assertName(dest.config, name);
      const previous = ctx.job.checkpoint["rename:" + itemKey];
      if (previous) {
        const current = await maybe(src, source.path);
        if (!current) {
          const destination = await maybe(dest, previous.dest);
          if (
            destination &&
            destination.identity === previous.source.identity
          ) {
            ctx.job.checkpoint["done:" + itemKey] = true;
            await ctx.save();
            continue;
          }
          throw Error("Move interrupted; inspect destination " + previous.dest);
        }
      }
      const copied = ctx.job.checkpoint[itemKey] as FileProgress | undefined;
      if (copied?.removed) {
        ctx.job.checkpoint["done:" + itemKey] = true;
        await ctx.save();
        continue;
      }
      if (
        input.mode === "move" &&
        copied?.committed &&
        !(await maybe(src, source.path))
      ) {
        await this.verifyCommitted(dest, copied);
        copied.removed = true;
        ctx.job.checkpoint["done:" + itemKey] = true;
        await ctx.save();
        continue;
      }
      const stat = await src.call<Entry>("stat", { path: source.path });
      const canonical =
        stat.kind === "symlink"
          ? spath.join(
              await src.call<string>("realpath", {
                path: spath.dirname(source.path),
              }),
              name,
            )
          : await src.call<string>("realpath", { path: source.path });
      const targetCanonical = await dest.call<string>("realpath", {
        path: input.target.path,
      });
      if (this.sameSharedPath?.({ endpoint: src.config.id, path: canonical },
          { endpoint: dest.config.id, path: dpath.join(targetCanonical, name) }))
        throw Error("源和目标是同一个共享文件，可直接引用原路径");
      const sourceKey = alias(src.config, source.path);
      const destKey = alias(dest.config, dpath.join(targetCanonical, name));
      if (
        sourceKey === destKey ||
        alias(src.config, canonical) ===
          alias(dest.config, dpath.join(targetCanonical, name))
      )
        throw Error("Source and destination refer to the same file");
      if (
        stat.kind === "directory" &&
        contains(
          alias(src.config, canonical),
          alias(dest.config, targetCanonical),
        )
      )
        throw Error("Target is inside source");
      let out = ctx.job.checkpoint["target:" + itemKey] as string | undefined;
      if (!out) {
        out = dpath.join(input.target.path, name);
        const existing = await maybe(dest, out);
        if (existing) {
          if (input.conflict === "skip") {
            skipped++;
            continue;
          }
          if (input.conflict === "rename") {
            const ext = stat.kind === "directory" ? "" : dpath.extname(name);
            const stem = name.slice(0, name.length - ext.length);
            let n = 2;
            while (await maybe(dest, out))
              out = dpath.join(
                input.target.path,
                stem + " (" + n++ + ")" + ext,
              );
          } else if (
            (existing.kind === "directory") !==
            (stat.kind === "directory")
          )
            throw Error("文件与目录类型冲突，请选择改名或跳过");
        }
        ctx.job.checkpoint["target:" + itemKey] = out;
        await ctx.save();
      }
      if (
        input.mode === "move" &&
        src === dest &&
        !ctx.job.checkpoint["copy:" + itemKey] &&
        !(
          stat.kind === "directory" &&
          input.conflict === "overwrite" &&
          (await maybe(dest, out))
        )
      ) {
        try {
          ctx.job.checkpoint["rename:" + itemKey] = { source: stat, dest: out };
          await ctx.save();
          await src.call("rename", {
            path: source.path,
            dest: out,
            overwrite: input.conflict === "overwrite",
          });
          ctx.progress({ files: ctx.job.files + 1 });
          this.invalidate(source);
          this.invalidate({ endpoint: dest.config.id, path: out });
          ctx.job.checkpoint["done:" + itemKey] = true;
          await ctx.save();
          continue;
        } catch (e: any) {
          if (e.code !== "EXDEV" && e.code !== 18) throw e;
        }
      }
      ctx.job.checkpoint["copy:" + itemKey] = true;
      await this.copy(
        ctx,
        src,
        source.path,
        dest,
        out,
        input.mode === "move",
        input.conflict === "overwrite",
        acquireBuffer,
      );
      this.invalidate(source);
      this.invalidate({ endpoint: dest.config.id, path: out });
      ctx.job.checkpoint["done:" + itemKey] = true;
      await ctx.save();
    }
    return { files: ctx.job.files, bytes: ctx.job.bytes, skipped };
  }
  private async copy(
    ctx: JobContext,
    src: Endpoint,
    p: string,
    dst: Endpoint,
    out: string,
    move: boolean,
    overwrite: boolean,
    acquireBuffer: AcquireBuffer,
    parallel = true,
  ): Promise<void> {
    ctx.check();
    const k = src.config.id + ":" + p;
    const save = () => {
      ctx.touch(k);
      return ctx.save();
    };
    const saved = ctx.job.checkpoint[k] as FileProgress | undefined;
    if (saved?.removed || (!move && saved?.committed)) return;
    let s: Entry;
    try {
      s = await src.call<Entry>("stat", { path: p });
    } catch (error: any) {
      if (move && saved?.committed && ["ENOENT", 2].includes(error.code)) {
        await this.verifyCommitted(dst, saved);
        saved.removed = true;
        await save();
        return;
      }
      throw error;
    }
    if (s.kind === "denied" || s.kind === "special")
      throw Error("Unsupported file identity: " + p + " (" + s.kind + ")");
    const dpath = pathApi(dst.config);
    assertName(dst.config, dpath.basename(out));
    if (s.kind === "directory") {
      const existing = await maybe(dst, out);
      if (existing && existing.kind !== "directory")
        throw Error("目录目标类型冲突：" + out);
      await dst.call("mkdir", { path: out });
      let cursor: string | undefined;
      // Snapshot child names before mutation: deleting source entries while scanning may skip files.
      const pendingKey = "children:" + k;
      let children: string[] = ctx.job.checkpoint[pendingKey];
      const smallFiles = new Set<string>();
      if (!children) {
        children = [];
        try {
          do {
            ctx.check();
            const page = await src.call("list", {
              path: p,
              cursor,
              limit: 200,
            });
            children.push(...page.entries.map((e: Entry) => e.path));
            for (const entry of page.entries as Entry[])
              if (entry.kind === "file" && entry.size <= 262144)
                smallFiles.add(entry.path);
            cursor = page.cursor;
          } while (cursor);
        } finally {
          if (cursor) await src.call("scanClose", { cursor }).catch(() => {});
        }
        ctx.job.checkpoint[pendingKey] = children;
        await save();
      }
      const batch: Promise<void>[] = [],
        targets = new Set<string>();
      const flush = async () => {
        const results = await Promise.allSettled(batch.splice(0));
        targets.clear();
        const error = results.find((r) => r.status === "rejected");
        if (error?.status === "rejected") throw error.reason;
      };
      for (const child of children) {
        const target = dpath.join(out, pathApi(src.config).basename(child));
        const key = alias(dst.config, target);
        if (parallel && smallFiles.has(child)) {
          if (targets.has(key)) await flush();
          targets.add(key);
          batch.push(
            this.copy(
              ctx,
              src,
              child,
              dst,
              target,
              move,
              overwrite,
              acquireBuffer,
              false,
            ),
          );
          if (batch.length === 4) await flush();
        } else {
          await flush();
          await this.copy(
            ctx,
            src,
            child,
            dst,
            target,
            move,
            overwrite,
            acquireBuffer,
            parallel,
          );
        }
      }
      await flush();
      if (move) await src.call("remove", { path: p }); // rmdir refuses new children added during transfer.
      ctx.job.checkpoint[k] = { removed: move, committed: true };
      await save();
      return;
    }
    if (s.kind === "symlink") {
      if (src.config.kind === "windows")
        Object.assign(s, await src.call("linkInfo", { path: p }));
      if (s.linkType === "junction" && dst.config.kind !== "windows")
        throw Error("目标文件系统不支持 Windows junction；源链接已保留");
      if (saved && changed(saved.source, s))
        throw Error("Source link changed; retained");
      if (saved?.committed) {
        if (move) {
          await this.verifyCommitted(dst, saved);
          await src.call("remove", { path: p, expected: saved.source });
          saved.removed = true;
          await save();
        }
        return;
      }
      if (
        dst.config.kind === "windows" &&
        s.targetKind === "missing" &&
        !s.linkTargetKind
      )
        throw Error("Windows requires a known link target type");
      const existing = await maybe(dst, out);
      if (existing && (!overwrite || existing.kind === "directory"))
        throw Error("Symlink destination conflicts: " + out);
      const partial =
        saved?.partial ??
        dpath.join(
          dpath.dirname(out),
          ".workspace-map-" +
            ctx.job.id +
            "-" +
            createHash("sha256").update(k).digest("hex").slice(0, 12) +
            ".link",
        );
      const record = saved ?? { source: s, dest: out, partial, offset: 0 };
      ctx.job.checkpoint[k] = record;
      await save();
      const staged = await maybe(dst, partial);
      if (staged) {
        if (staged.kind !== "symlink" || staged.target !== s.target)
          throw Error("Staged link changed");
      } else
        await dst.call("symlink", {
          path: partial,
          target: s.target,
          targetKind: s.linkTargetKind ?? s.targetKind,
          linkType: s.linkType,
        });
      await dst.call("rename", { path: partial, dest: out, overwrite });
      record.committed = true;
      await save();
      if (move) {
        ctx.check();
        await src.call("remove", { path: p, expected: s });
        record.removed = true;
        await save();
      }
      ctx.progress({ files: ctx.job.files + 1 });
      return;
    }
    const wasCommitted = !!saved?.committed;
    let f = saved;
    if (!f) {
      const suffix = createHash("sha256").update(k).digest("hex").slice(0, 16);
      f = {
        source: s,
        dest: out,
        partial: dpath.join(
          dpath.dirname(out),
          ".workspace-map-" + ctx.job.id + "-" + suffix + ".partial",
        ),
        offset: 0,
      };
      ctx.job.checkpoint[k] = f;
      await save();
      await dst.call("write", {
        path: f.partial,
        data: "",
        offset: 0,
        exclusive: true,
      });
      await save();
    }
    if (changed(f.source, s))
      throw Error("Source changed; source and partial retained: " + p);
    if (!f.committed) {
      let partial = await maybe(dst, f.partial);
      if (!partial && f.offset === 0) {
        await dst.call("write", {
          path: f.partial,
          data: "",
          offset: 0,
          exclusive: true,
        });
        partial = await dst.call<Entry>("stat", { path: f.partial });
      }
      if (!partial)
        throw Error("Partial file missing after committed progress");
      if (partial.kind !== "file" || partial.size < f.offset)
        throw Error("Partial file changed: " + f.partial);
      const timing = this.timings.get(ctx.job)!;
      const route = this.route.get(ctx.job)!;
      if (f.peer) await this.peer?.fence(dst.config, partial);
      if (f.offset) {
        const [sourcePrefix, targetPrefix] = await timing.measure("verify", () => Promise.all([
          this.prefixHash(src, p, f.offset),
          this.prefixHash(dst, f.partial, f.offset),
        ]));
        if (sourcePrefix !== targetPrefix)
          throw Error("Partial content changed; source retained");
      }
      const input = ctx.job.input as TransferInput;
      const pair = input.transport !== "relay" && s.size - f.offset >= 8 * 1024 * 1024
        ? this.operations?.pair(src.config.id, dst.config.id) : undefined;
      if (pair && this.peer) {
        const before = f.offset;
        const progress = async (offset: number) => {
          const bytes = offset - f!.offset;
          if (bytes <= 0) return;
          f!.offset = offset;
          route.directBytes += bytes;
          ctx.progress({ bytes: ctx.job.bytes + bytes, progress: p });
          await save();
        };
        f.peer = true;
        await save();
        const result = await timing.measure("direct", () => this.peer!.send(ctx, pair,
          src.config, dst.config, s, partial!, before, progress));
        route.readMs += result.readMs;
        route.writeMs += result.writeMs;
        route.syncMs += result.syncMs;
        route.cpuMs += result.cpuMs;
        if (!result.completed && f.offset < s.size) {
          const reason = result.reason ?? "直传提前结束";
          if (!route.reasons.includes(reason) && route.reasons.length < 5) route.reasons.push(reason);
          if (f.offset > before && f.offset < s.size) {
            const [sourcePrefix, targetPrefix] = await timing.measure("verify", () => Promise.all([
              this.prefixHash(src, p, f!.offset), this.prefixHash(dst, f!.partial, f!.offset),
            ]));
            if (sourcePrefix !== targetPrefix) throw Error("直传暂存校验失败，源文件保留");
          }
        }
      }
      const chunk = 1048576;
      const window = 4;
      while (f.offset < s.size) {
        ctx.check();
        const start = f.offset;
        const offsets = Array.from(
          { length: Math.min(window, Math.ceil((s.size - start) / chunk)) },
          (_, i) => start + i * chunk,
        );
        const results = await Promise.allSettled(
          offsets.map(async (offset) => {
            const lease = await acquireBuffer();
            try {
              ctx.check();
              const length = Math.min(chunk, s.size - offset);
              let data: string | undefined;
              let bytes: number;
              const buffer = lease.buffer;
              bytes = await timing.measure("read", async () => {
                if (src.readInto) return src.readInto(p, buffer, offset, length);
                data = await src.call<string>("read", { path: p, offset, length });
                if (dst.writeBuffer) {
                  const start = performance.now();
                  buffer.write(data, 0, "base64");
                  route.encodingMs += performance.now() - start;
                }
                return (data.length * 3) / 4 -
                  (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
              });
              if (bytes !== length) throw Error("Source changed during read");
              await timing.measure("write", () => {
                if (dst.writeBuffer) return dst.writeBuffer(f!.partial, buffer.subarray(0, bytes), offset);
                const start = performance.now();
                const encoded = data ?? buffer.subarray(0, bytes).toString("base64");
                route.encodingMs += performance.now() - start;
                return dst.call("write", { path: f!.partial, data: encoded, offset });
              });
              return bytes;
            } finally {
              lease.release();
            }
          }),
        );
        const error = results.find((r) => r.status === "rejected");
        if (error?.status === "rejected") throw error.reason;
        const bytes = results.reduce(
          (sum, r) => sum + (r.status === "fulfilled" ? r.value : 0),
          0,
        );
        f.offset += bytes;
        route.relayBytes += bytes;
        ctx.progress({ bytes: ctx.job.bytes + bytes, progress: p });
        await save();
      }
      ctx.check();
      const [before, after, targetHash] = await timing.measure("verify", () => Promise.all([
        src.call<string>("hash", { path: p, size: s.size }),
        src.call<Entry>("stat", { path: p }),
        dst.call<string>("hash", { path: f.partial, size: s.size }),
      ]));
      if (changed(f.source, after) || before !== targetHash)
        throw Error("Verification failed; source and partial retained: " + p);
      await dst.call("metadata", {
        path: f.partial,
        mode: s.mode,
        mtime: s.mtime,
      });
      await dst.call("rename", { path: f.partial, dest: out, overwrite });
      f.digest = before;
      f.committed = true;
      await save();
    }
    if (move) {
      ctx.check();
      if (wasCommitted) await this.verifyCommitted(dst, f);
      await src.call("remove", { path: p, expected: f.source });
      f.removed = true;
      await save();
    }
    ctx.progress({ files: ctx.job.files + 1 });
  }
  private async verifyCommitted(endpoint: Endpoint, f: FileProgress) {
    const target = await endpoint.call<Entry>("stat", { path: f.dest });
    if (target.kind !== f.source.kind)
      throw Error("Destination changed; source retained");
    if (f.source.kind === "symlink") {
      if (target.target !== f.source.target)
        throw Error("Destination link changed; source retained");
      return;
    }
    if (
      !f.digest ||
      target.size !== f.source.size ||
      (await endpoint.call<string>("hash", { path: f.dest })) !== f.digest
    )
      throw Error("Destination changed; source retained");
  }
  private async prefixHash(e: Endpoint, p: string, size: number) {
    return e.call<string>("hashPrefix", { path: p, length: size });
  }
}
