import fs from "node:fs/promises";
import path from "node:path";
import type { Endpoints } from "../adapters/registry";
import type { Entry, Ref } from "../shared/types";
import { pathApi } from "../shared/paths";

const fileLimit = 1024 * 1024;
const kinds = new Set(["wait", "compute", "communication", "write", "other"]);
type Stage = {
  kind: string;
  label?: string;
  offsetMs: number;
  durationMs: number;
  bytes?: number;
};
type Indexed = { ref: Ref; runId: string; project: string; label: string };
const duration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 160;

export function parseRunProfile(source: string) {
  const v = JSON.parse(source);
  if (
    v?.version !== 1 ||
    !text(v.runId) ||
    !text(v.project) ||
    !text(v.label) ||
    !text(v.commit) ||
    !text(v.dataset) ||
    !duration(v.durationMs) ||
    v.durationMs === 0 ||
    !Number.isSafeInteger(v.samples) ||
    v.samples < 0 ||
    !Array.isArray(v.nodes) ||
    v.nodes.length < 1 ||
    v.nodes.length > 64
  )
    throw Error("性能记录格式无效，请选择 version: 1 的运行记录");
  let count = 0;
  const ids = new Set<string>();
  const nodes = (v.nodes as any[]).map((node: any) => {
    if (
      !text(node?.endpoint) ||
      !text(node?.label) ||
      (node.startedAt != null && !duration(node.startedAt)) ||
      ids.has(node.endpoint) ||
      !Array.isArray(node.stages)
    )
      throw Error("运行记录的节点信息无效");
    ids.add(node.endpoint);
    count += node.stages.length;
    if (count > 4000) throw Error("运行记录最多含 4000 个阶段");
    const log = node.log;
    if (
      log != null &&
      (log.endpoint !== node.endpoint ||
        typeof log.path !== "string" ||
        !log.path ||
        log.path.length > 4096)
    )
      throw Error("原始日志需位于记录所指的节点");
    const stages: Stage[] = node.stages.map((s: any) => {
      if (
        !kinds.has(s?.kind) ||
        (s.label != null && !text(s.label)) ||
        !duration(s.offsetMs) ||
        !duration(s.durationMs) ||
        !Number.isFinite(s.offsetMs + s.durationMs) ||
        (s.bytes != null && (!Number.isSafeInteger(s.bytes) || s.bytes < 0))
      )
        throw Error("运行记录的阶段信息无效");
      return {
        kind: s.kind,
        label: s.label,
        offsetMs: s.offsetMs,
        durationMs: s.durationMs,
        bytes: s.bytes,
      };
    });
    stages.sort((a, b) => a.offsetMs - b.offsetMs);
    return {
      endpoint: node.endpoint as string,
      label: node.label as string,
      startedAt: node.startedAt as number | undefined,
      log: log as Ref | undefined,
      stages,
    };
  });
  const phaseTotals: Record<string, number> = {};
  const segments = new Map<
    string,
    { kind: string; label?: string; durationMs: number }
  >();
  for (const node of nodes) {
    const until: Record<string, number> = {};
    const labelUntil = new Map<string, number>();
    for (const stage of node.stages) {
      const end = stage.offsetMs + stage.durationMs;
      const start = Math.max(stage.offsetMs, until[stage.kind] ?? 0);
      phaseTotals[stage.kind] =
        (phaseTotals[stage.kind] ?? 0) + Math.max(0, end - start);
      until[stage.kind] = Math.max(until[stage.kind] ?? 0, end);
      const key = JSON.stringify([stage.kind, stage.label]);
      const item = segments.get(key) ?? {
        kind: stage.kind,
        label: stage.label,
        durationMs: 0,
      };
      const previous = labelUntil.get(key) ?? 0;
      item.durationMs += Math.max(0, end - Math.max(previous, stage.offsetMs));
      segments.set(key, item);
      labelUntil.set(key, Math.max(previous, end));
    }
  }
  return {
    runId: v.runId as string,
    project: v.project as string,
    label: v.label as string,
    commit: v.commit as string,
    dataset: v.dataset as string,
    samples: v.samples as number,
    durationMs: v.durationMs as number,
    nodes,
    count,
    phaseTotals,
    longest: [...segments.values()].sort(
      (a, b) => b.durationMs - a.durationMs,
    )[0],
  };
}

export class RunProfiles {
  private publishing = Promise.resolve();
  constructor(
    private endpoints: Endpoints,
    private directory: string,
  ) {}

  private get indexFile() {
    return path.join(this.directory, "run-profiles.json");
  }

  async list(): Promise<Indexed[]> {
    return fs.readFile(this.indexFile, "utf8").then(JSON.parse, (error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  }

  private remember(entry: Indexed) {
    this.publishing = this.publishing
      .catch(() => {})
      .then(async () => {
        const list = await this.list();
        const next = [
          entry,
          ...list.filter(
            ({ ref }) =>
              ref.endpoint !== entry.ref.endpoint ||
              ref.path !== entry.ref.path,
          ),
        ].slice(0, 40);
        await fs.writeFile(this.indexFile + ".tmp", JSON.stringify(next), {
          mode: 0o600,
        });
        await fs.rename(this.indexFile + ".tmp", this.indexFile);
      });
    return this.publishing;
  }

  async read({
    ref,
    offset = 0,
    limit = 100,
    remember = false,
  }: {
    ref: Ref;
    offset?: number;
    limit?: number;
    remember?: boolean;
  }) {
    if (
      !ref ||
      typeof ref.endpoint !== "string" ||
      typeof ref.path !== "string"
    )
      throw Error("请选择性能记录文件");
    const endpoint = this.endpoints.get(ref.endpoint);
    if (!pathApi(endpoint.config).isAbsolute(ref.path))
      throw Error("请使用记录文件的绝对路径");
    const entry = await endpoint.call<Entry>("stat", { path: ref.path });
    if (entry.kind !== "file" || entry.size > fileLimit)
      throw Error("性能记录需要是 1 MiB 以内的 JSON 文件");
    const raw = await endpoint.call<string>("read", {
      path: ref.path,
      offset: 0,
      length: entry.size,
    });
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length !== entry.size) throw Error("记录文件正在修改，请刷新");
    const { nodes, count, ...summary } = parseRunProfile(
      decoded.toString("utf8"),
    );
    for (const node of nodes) {
      if (!node.log) continue;
      const mount = this.endpoints
        .configs()
        .find((c) => c.id === node.log?.endpoint);
      if (mount && !pathApi(mount).isAbsolute(node.log.path))
        throw Error("原始日志路径需要是绝对路径");
      if (!mount) node.log = undefined;
    }
    if (remember)
      await this.remember({
        ref,
        runId: summary.runId,
        project: summary.project,
        label: summary.label,
      });
    offset = Math.min(count, Math.max(0, Math.floor(Number(offset) || 0)));
    limit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
    return {
      ...summary,
      ref,
      count,
      nodes: nodes.map(({ stages, ...node }) => ({
        ...node,
        stageCount: stages.length,
      })),
      stages: nodes
        .flatMap((node) =>
          node.stages.map((s) => ({ ...s, endpoint: node.endpoint })),
        )
        .slice(offset, offset + limit),
      offset,
      next: offset + limit < count ? offset + limit : undefined,
    };
  }
}
