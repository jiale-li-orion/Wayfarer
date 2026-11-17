import path from "node:path";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import type { Endpoints } from "../adapters/registry";
import type { Page, Ref } from "../shared/types";
import { refKey, parseKey } from "../shared/types";
import type { Profiler } from "./log";
export class Directories extends EventEmitter {
  private mapRefs: Ref[] = [];
  private visible = true;
  private uiReads = new Map<string, object>();
  private changes = new Map<string, Ref>();
  private changeTimer?: NodeJS.Timeout;
  private remoteUpdates = new Map<string, Promise<void>>();
  private external = new Map<string, { ref: Ref; count: number }>();
  private cache = new Map<string, Page>();
  private entries = 0;
  private uiCursors = new Map<string, string>();
  private watched = new Map<
    string,
    {
      ref: Ref;
      identity?: string;
      next: number;
      failures: number;
      watcher?: FSWatcher;
      timer?: NodeJS.Timeout;
    }
  >();
  private remoteWatches = new Map<string, boolean>();
  private remoteKeys = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private disposed = false;
  constructor(
    private endpoints: Endpoints,
    private profile: Profiler,
    private pageSize = 200,
  ) {
    super();
  }
  async list(
    ref: Ref,
    cursor?: string,
    refresh = false,
    scope: "ui" | "agent" | "editor" = "ui",
  ): Promise<Page> {
    const key = refKey(ref),
      known = this.cache.get(key);
    if (!this.endpoints.enabled(ref.endpoint)) {
      if (known) return { ...known, cached: true, error: "端点已断开" };
      throw Error("端点已断开");
    }
    if (
      !cursor &&
      !refresh &&
      known &&
      !known.hasMore &&
      !known.cached &&
      Date.now() - known.stamp < 5000
    )
      return { ...known, cached: true };
    if (!cursor && scope === "ui") this.closeUiCursor(key);
    const request = {};
    if (scope === "ui") this.uiReads.set(key, request);
    const endpoint = this.endpoints.get(ref.endpoint);
    try {
      const page = await this.profile.time(
        "directory.read",
        { endpoint: ref.endpoint, path: ref.path, cursor: !!cursor, scope },
        () =>
          endpoint.call<Page>("list", {
            path: ref.path,
            cursor,
            limit: this.pageSize,
          }),
      );
      page.entries.sort(
        (a, b) =>
          (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) ||
          a.name.localeCompare(b.name),
      );
      if (
        scope === "ui" &&
        (this.disposed || !this.visible || this.uiReads.get(key) !== request)
      ) {
        if (page.cursor)
          await endpoint
            .call("scanClose", { cursor: page.cursor })
            .catch(() => {});
        return { ...page, hasMore: !!page.cursor, cursor: undefined };
      }
      if (scope === "ui") {
        if (page.cursor) this.uiCursors.set(key, page.cursor);
        else this.uiCursors.delete(key);
      }
      if (!cursor) {
        this.evict(key);
        this.cache.set(key, {
          ...page,
          cursor: undefined,
          hasMore: !!page.cursor,
        });
        this.entries += page.entries.length;
        while (this.entries > 16000 || this.cache.size > 128)
          this.evict(this.cache.keys().next().value!);
      }
      return page;
    } catch (error) {
      if (!cursor && known)
        return { ...known, cached: true, error: String(error) };
      throw error;
    } finally {
      if (this.uiReads.get(key) === request) this.uiReads.delete(key);
    }
  }
  private closeUiCursor(key: string, retireRead = true) {
    if (retireRead) this.uiReads.delete(key);
    const cursor = this.uiCursors.get(key);
    this.uiCursors.delete(key);
    if (!cursor) return;
    const ref = parseKey(key),
      e = this.endpoints.items.get(ref.endpoint);
    if (
      e &&
      this.endpoints.enabled(ref.endpoint) &&
      (e.connected || ["local", "windows"].includes(e.config.kind))
    )
      void e.call("scanClose", { cursor }).catch(() => {});
  }
  private evict(key: string) {
    const p = this.cache.get(key);
    if (p) {
      this.entries -= p.entries.length;
      this.cache.delete(key);
    }
  }
  invalidate(ref: Ref) {
    this.closeUiCursor(refKey(ref), false);
    this.evict(refKey(ref));
    if (this.disposed) return;
    this.changes.set(refKey(ref), ref);
    // Coalesce a transfer/watch burst per branch, with a fixed flush window.
    if (!this.changeTimer)
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined;
        const changes = [...this.changes.values()];
        this.changes.clear();
        for (const ref of changes) this.emit("change", ref);
      }, 150);
  }
  snapshot() {
    return [...this.cache.entries()];
  }
  restore(data: [string, Page][]) {
    for (const [k, p] of data.slice(-80)) {
      this.cache.set(k, { ...p, cached: true });
      this.entries += p.entries.length;
    }
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.reconcile();
  }
  stats() {
    return {
      cachedBranches: this.cache.size,
      cachedEntries: this.entries,
      uiCursors: this.uiCursors.size,
      pendingUiReads: this.uiReads.size,
      watches: this.watched.size,
      editorWatches: this.external.size,
      pendingChanges: this.changes.size,
      polling: !!this.timer,
      visible: this.visible,
    };
  }
  watch(refs: Ref[]) {
    this.mapRefs = refs;
    this.reconcile();
  }
  retain(ref: Ref) {
    if (this.disposed) return () => {};
    const key = refKey(ref);
    const current = this.external.get(key);
    this.external.set(key, { ref, count: (current?.count ?? 0) + 1 });
    this.reconcile();
    return () => {
      const current = this.external.get(key);
      if (current && current.count > 1) current.count--;
      else this.external.delete(key);
      this.reconcile();
    };
  }
  private reconcile() {
    let refs = [
      ...(this.visible ? this.mapRefs : []),
      ...[...this.external.values()].map((v) => v.ref),
    ];
    refs = refs.filter((r) => this.endpoints.enabled(r.endpoint));
    const next = new Set(refs.map(refKey));
    const visible = new Set(this.visible ? this.mapRefs.map(refKey) : []);
    for (const key of new Set([
      ...this.uiCursors.keys(),
      ...this.uiReads.keys(),
    ]))
      if (!visible.has(key)) this.closeUiCursor(key);
    for (const [k, w] of this.watched)
      if (!next.has(k)) {
        w.watcher?.close();
        clearTimeout(w.timer);
        this.watched.delete(k);
      }
    for (const ref of refs) {
      const key = refKey(ref);
      if (this.watched.has(key)) continue;
      const w: {
        ref: Ref;
        identity?: string;
        next: number;
        failures: number;
        watcher?: FSWatcher;
        timer?: NodeJS.Timeout;
      } = { ref, next: 0, failures: 0 };
      const e = this.endpoints.get(ref.endpoint);
      if (e.config.kind === "windows" || e.config.kind === "local") {
        try {
          w.watcher = watch(ref.path, { persistent: false }, (_, filename) => {
            clearTimeout(w.timer);
            w.timer = setTimeout(() => {
              this.invalidate(ref);
              if (filename)
                this.emit("file", {
                  endpoint: ref.endpoint,
                  path: path.join(ref.path, filename.toString()),
                });
            }, 150);
          });
          w.watcher.on("error", () => {
            w.watcher?.close();
            w.watcher = undefined;
          });
        } catch {}
      }
      this.watched.set(key, w);
      this.invalidate(ref);
    }
    const remoteGroups = new Map<string, string[]>();
    for (const w of this.watched.values()) {
      const c = this.endpoints.get(w.ref.endpoint).config;
      if (c.kind === "wsl" || c.kind === "ssh") {
        const p = remoteGroups.get(c.id) ?? [];
        p.push(w.ref.path);
        remoteGroups.set(c.id, p);
      }
    }
    for (const id of new Set([
      ...this.remoteKeys.keys(),
      ...remoteGroups.keys(),
    ])) {
      const paths = remoteGroups.get(id) ?? [];
      if (!this.endpoints.enabled(id)) {
        this.remoteKeys.delete(id);
        this.remoteWatches.delete(id);
        continue;
      }
      const key = paths.join("\0");
      if (this.remoteKeys.get(id) === key) continue;
      this.remoteKeys.set(id, key);
      const endpoint = this.endpoints.get(id);
      const previous = this.remoteUpdates.get(id) ?? Promise.resolve();
      const update = previous
        .catch(() => {})
        .then(async () => {
          if (
            !this.endpoints.enabled(id) ||
            this.endpoints.items.get(id) !== endpoint
          )
            return;
          try {
            const ok = await endpoint.call<boolean>("watchSet", { paths });
            if (this.remoteKeys.get(id) === key) this.remoteWatches.set(id, ok);
          } catch {
            if (this.remoteKeys.get(id) === key)
              this.remoteWatches.set(id, false);
          }
        });
      this.remoteUpdates.set(id, update);
      void update.finally(() => {
        if (this.remoteUpdates.get(id) === update)
          this.remoteUpdates.delete(id);
      });
    }
    if (this.watched.size && !this.timer) {
      this.timer = setInterval(() => void this.poll(), 5000);
      this.timer.unref();
    }
    if (!this.watched.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  private async poll() {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const groups = new Map<
        string,
        typeof this.watched extends Map<any, infer V> ? V[] : never
      >();
      for (const w of this.watched.values()) {
        if (w.watcher || w.next > Date.now()) continue;
        const group = groups.get(w.ref.endpoint) ?? [];
        if (group.length < 64) {
          group.push(w);
          groups.set(w.ref.endpoint, group);
        }
      }
      await Promise.all(
        [...groups].map(async ([id, group]) => {
          try {
            if (this.remoteWatches.get(id)) {
              const changed = await this.endpoints
                .get(id)
                .call<{ paths: string[]; overflow: boolean }>("watchPoll");
              if (changed.overflow)
                for (const w of group) this.invalidate(w.ref);
              for (const p of changed.paths) {
                const parent = { endpoint: id, path: path.posix.dirname(p) };
                if (this.watched.has(refKey(parent))) this.invalidate(parent);
                if (this.watched.has(refKey({ endpoint: id, path: p })))
                  this.invalidate({ endpoint: id, path: p });
                this.emit("file", { endpoint: id, path: p });
              }
              return;
            }
            const stats = await this.endpoints
              .get(id)
              .call<any[]>("statMany", { paths: group.map((w) => w.ref.path) });
            for (let i = 0; i < group.length; i++) {
              const w = group[i];
              const s = stats[i];
              w.next = Date.now() + 5000;
              if (s.error) {
                w.failures++;
                w.next = Date.now() + Math.min(60000, 5000 * 2 ** w.failures);
                continue;
              }
              const identity = s.identity + ":" + s.mtime;
              if (w.identity && w.identity !== identity) this.invalidate(w.ref);
              w.identity = identity;
              w.failures = 0;
            }
          } catch (e) {
            for (const w of group) {
              w.failures++;
              w.next = Date.now() + Math.min(60000, 5000 * 2 ** w.failures);
            }
            this.emit("offline", { ref: group[0].ref, error: String(e) });
          }
        }),
      );
    } finally {
      this.polling = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.external.clear();
    this.watch([]);
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.changes.clear();
    this.cache.clear();
    this.entries = 0;
  }
}
