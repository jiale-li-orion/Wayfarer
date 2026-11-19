import type { Endpoints } from "../adapters/registry";
import type { Entry, Ref } from "../shared/types";
import { pathApi } from "../shared/paths";

const pageBytes = 65536;

function integer(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw Error("无效的 " + name);
  return value;
}

export async function modelAnalysis(
  endpoints: Endpoints,
  args: {
    ref: Ref;
    view?: "run" | "events" | "step" | "behavior";
    cursor?: number;
    attempt?: number;
    module?: string;
    sample?: string;
  },
) {
  const { ref, view = "run" } = args;
  if (!ref || typeof ref.path !== "string") throw Error("请选择 run.json");
  const ep = endpoints.get(ref.endpoint);
  const paths = pathApi(ep.config);
  if (!paths.isAbsolute(ref.path)) throw Error("需要实验记录的绝对路径");
  const root = paths.dirname(ref.path);
  async function stat(file: string) {
    const entry = await ep.call<Entry>("stat", { path: file });
    if (entry.kind !== "file") throw Error("请选择普通文件");
    return entry;
  }
  async function bytes(file: string, offset: number, length: number) {
    if (!length) return Buffer.alloc(0);
    return Buffer.from(
      await ep.call<string>("read", { path: file, offset, length }),
      "base64",
    );
  }
  async function readJson(file: string, max: number) {
    const entry = await stat(file);
    if (entry.size > max) throw Error("记录超过单次读取上限");
    const data = await bytes(file, 0, entry.size);
    if (data.length !== entry.size) throw Error("文件正在变更，请刷新");
    return JSON.parse(data.toString("utf8"));
  }
  const run = await readJson(ref.path, pageBytes);
  if (
    run.schema !== "wayfarer.model/1" ||
    typeof run.runId !== "string" ||
    typeof run.segment !== "string" ||
    !Number.isSafeInteger(run.rank)
  )
    throw Error("请选择模型分析 v1 的 run.json");
  if (view === "run") return { ref, run };
  if (view === "behavior") {
    const behavior = await readJson(
      paths.join(root, "behavior.json"),
      1024 * 1024,
    );
    if (
      run.type !== "behavior" ||
      behavior.runId !== run.runId ||
      behavior.segment !== run.segment ||
      behavior.rank !== run.rank ||
      !Array.isArray(behavior.pairs) ||
      behavior.pairs.length > 32 ||
      !Array.isArray(behavior.metrics)
    )
      throw Error("行为对照记录与所选实验不匹配");
    if (args.sample)
      behavior.pairs = behavior.pairs.filter((p: any) => p.id === args.sample);
    return { ref, behavior };
  }
  if (view === "step") {
    const attempt = integer(args.attempt, "更新尝试编号");
    const step = await readJson(
      paths.join(root, "step-" + attempt + ".json"),
      1024 * 1024,
    );
    if (
      step.attempt !== attempt ||
      step.segment !== run.segment ||
      step.runId !== run.runId ||
      step.rank !== run.rank
    )
      throw Error("更新记录与所选实验不匹配");
    if (args.module)
      step.modules = step.modules.filter((m: any) => m.name === args.module);
    if (args.sample)
      step.microbatches = step.microbatches
        .map((m: any) => ({
          ...m,
          samples: m.samples.filter((s: any) => s.id === args.sample),
        }))
        .filter((m: any) => m.samples.length);
    return { ref, step };
  }
  if (view !== "events") throw Error("未知观测视图");
  const file = paths.join(root, "events.jsonl");
  const cursor = integer(args.cursor ?? 0, "事件游标");
  const entry = await stat(file);
  if (cursor > entry.size) throw Error("事件流已替换，请重新打开运行");
  const raw = await bytes(
    file,
    cursor,
    Math.min(pageBytes, entry.size - cursor),
  );
  const end = raw.lastIndexOf(10) + 1;
  if (!end && raw.length === pageBytes) throw Error("单条事件超过页上限");
  const events = end
    ? raw
        .subarray(0, end - 1)
        .toString("utf8")
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return {
    ref,
    events,
    cursor: cursor + end,
    more: end > 0 && cursor + end < entry.size,
  };
}
