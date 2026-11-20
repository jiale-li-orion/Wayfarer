import { createHash } from "node:crypto";
import type { Endpoints } from "../adapters/registry";
import { pathApi } from "../shared/paths";
import { refKey, type Entry, type Ref, type Page } from "../shared/types";
import type { Workloads, WorkloadFile } from "./workloads";

/** One metadata page per project and refresh. Entries are published by atomic replacement. */
export class ProjectRuns {
  private states = new Map<
    string,
    {
      stamp?: string;
      scanStamp?: string;
      cursor?: string;
      next: number;
      seen: Map<string, string>;
      project: Ref;
    }
  >();
  private inflight = new Map<string, Promise<void>>();
  private generation = 0;
  constructor(
    private endpoints: Endpoints,
    private workloads: Workloads,
    private log: (fields: Record<string, unknown>) => void,
  ) {}
  private pagesRead = 0;
  stats() {
    return {
      projects: this.states.size,
      inflight: this.inflight.size,
      cursors: [...this.states.values()].filter((s) => s.cursor).length,
      pagesRead: this.pagesRead,
    };
  }
  get more() {
    return [...this.states.values()].some((s) => !!s.cursor);
  }
  async refresh(projects: Ref[], allowed?: Set<string>) {
    const keys = new Set(projects.map(refKey));
    for (const [key, state] of this.states) {
      if (this.inflight.has(key)) continue;
      if (!keys.has(key)) {
        this.states.delete(key);
        await this.close(state);
      } else if (
        allowed &&
        !allowed.has(state.project.endpoint) &&
        state.cursor
      ) {
        state.stamp = undefined;
        await this.close(state);
      }
    }
    await Promise.all(
      projects
        .filter((p) => !allowed || allowed.has(p.endpoint))
        .map((project) => {
          const key = refKey(project),
            existing = this.inflight.get(key);
          if (existing) return existing;
          const state = this.states.get(key) ?? {
            project,
            next: 0,
            seen: new Map<string, string>(),
          };
          this.states.set(key, state);
          if (state.next > Date.now()) return;
          const gen = this.generation;
          const work = this.read(state, gen)
            .catch(async (e) => {
              await this.close(state);
              state.stamp = undefined;
              state.next = Date.now() + 10000;
              if (
                !["ENOENT", "FileNotFoundError"].includes(
                  String(e.code ?? e.type),
                )
              )
                this.log({ project, error: String(e) });
            })
            .finally(() => this.inflight.delete(key));
          this.inflight.set(key, work);
          return work;
        }),
    );
  }
  private async close(s: { project: Ref; cursor?: string }) {
    const cursor = s.cursor;
    s.cursor = undefined;
    if (cursor)
      await this.endpoints.items
        .get(s.project.endpoint)
        ?.call("scanClose", { cursor })
        .catch(() => {});
  }
  async release() {
    this.generation++;
    await Promise.allSettled(this.inflight.values());
    await Promise.all([...this.states.values()].map((s) => this.close(s)));
  }
  private async read(
    s: {
      stamp?: string;
      scanStamp?: string;
      cursor?: string;
      next: number;
      seen: Map<string, string>;
      project: Ref;
    },
    gen: number,
  ) {
    const project = s.project,
      ep = this.endpoints.get(project.endpoint),
      api = pathApi(ep.config);
    const parent = api.join(project.path, ".wayfarer"),
      dir = api.join(parent, "runs");
    s.next = Date.now() + 10000;
    const parentStat = await ep.call<Entry>("stat", { path: parent });
    if (parentStat.kind !== "directory") {
      await this.close(s);
      s.stamp = undefined;
      return;
    }
    const info = await ep.call<Entry>("stat", { path: dir });
    if (info.kind !== "directory") {
      await this.close(s);
      s.stamp = undefined;
      return;
    }
    const stamp = [info.identity, info.mtime, info.ctime].join("/");
    if (!s.cursor && s.stamp === stamp) return;
    if (!s.cursor) s.scanStamp = stamp;
    this.pagesRead++;
    const page = await ep.call<Page>("list", {
      path: dir,
      cursor: s.cursor,
      limit: 64,
    });
    s.cursor = page.cursor;
    for (const entry of page.entries) {
      if (this.generation !== gen) {
        s.stamp = undefined;
        await this.close(s);
        return;
      }
      if (
        entry.kind !== "file" ||
        entry.size > 65536 ||
        !/^([a-f0-9]{64})\.json$/.test(entry.name)
      )
        continue;
      const version = [
        entry.identity,
        entry.mtime,
        entry.ctime,
        entry.size,
      ].join("/");
      if (s.seen.get(entry.name) === version) continue;
      try {
        const body = Buffer.from(
          await ep.call<string>("readRunIndex", {
            path: api.join(dir, entry.name),
          }),
          "base64",
        );
        if (this.generation !== gen) {
          s.stamp = undefined;
          await this.close(s);
          return;
        }
        if (body.length !== entry.size) continue;
        const v = JSON.parse(body.toString("utf8"));
        if (
          v.schema !== "wayfarer.run/1" ||
          typeof v.runId !== "string" ||
          createHash("sha256").update(v.runId).digest("hex") + ".json" !==
            entry.name
        )
          throw Error("索引身份不匹配");
        const resolve = (p: unknown) => {
          if (typeof p !== "string" || !p) throw Error("运行引用缺少路径");
          return api.resolve(project.path, p);
        };
        const files: WorkloadFile[] = (v.files ?? []).map((f: any) => ({
          endpoint: project.endpoint,
          kind: f.kind,
          label: f.label,
          path: resolve(f.path),
        }));
        await this.workloads.importRecord(
          {
            runId: v.runId,
            endpoint: project.endpoint,
            projectRef: project,
            name: v.name,
            statusPath: v.statusPath ? resolve(v.statusPath) : undefined,
            files,
          },
          createHash("sha256").update(body).digest("hex"),
        );
        if (s.seen.size >= 2048) s.seen.delete(s.seen.keys().next().value!);
        s.seen.set(entry.name, version);
      } catch (e) {
        this.log({ project, entry: entry.name, error: String(e) });
      }
    }
    if (!s.cursor) s.stamp = s.scanStamp === stamp ? stamp : undefined;
    else {
      s.stamp = undefined;
      s.next = 0;
    }
  }
}
