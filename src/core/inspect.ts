import fs from "node:fs/promises";
import path from "node:path";
import type { Endpoint, Ref } from "../shared/types";
import { refKey } from "../shared/types";
import { pathApi } from "../shared/paths";
import type { Endpoints } from "../adapters/registry";
import type { JobContext } from "./jobs";
import type { Profiler } from "./log";
import { projectEnvironment, type EnvironmentChoice } from "./environment";
import { discover } from "../packages/discovery";

const markers: Record<string, string> = {
  "package.json": "Node",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "yarn.lock": "Yarn",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  "uv.lock": "uv",
  "poetry.lock": "Poetry",
  ".python-version": "Python",
  "pyvenv.cfg": "Python environment",
  "Cargo.toml": "Rust",
  "Cargo.lock": "Cargo",
  "rust-toolchain.toml": "Rust",
  "go.mod": "Go",
  "go.sum": "Go",
  "pom.xml": "Maven",
  mvnw: "Maven Wrapper",
  "mvnw.cmd": "Maven Wrapper",
  gradlew: "Gradle Wrapper",
  "gradlew.bat": "Gradle Wrapper",
  "build.gradle": "Gradle",
  "build.gradle.kts": "Gradle",
  "settings.gradle.kts": "Gradle",
  "pubspec.yaml": "Flutter",
  "pubspec.lock": "Dart",
  ".flutter-version": "Flutter",
  ".git": "Git",
  ".venv": "Python environment",
  venv: "Python environment",
  node_modules: "Node environment",
  ".dart_tool": "Dart environment",
};
const versions: Record<string, string[]> = {
  node: ["--version"],
  uv: ["--version"],
  python3: ["--version"],
  python: ["--version"],
  npm: ["--version"],
  pnpm: ["--version"],
  bun: ["--version"],
  java: ["-version"],
  gradle: ["--version"],
  mvn: ["--version"],
  sdkmanager: ["--version"],
  flutter: ["--version"],
  rustup: ["--version"],
  cargo: ["--version"],
  winget: ["--version"],
};
type Snapshot = { stamp: number; value: any };
/** On-demand snapshots: bounded, timestamped, coalesced; no polling or directory watches. */
export class Inspector {
  private cache = new Map<string, Snapshot>();
  private weights = new Map<string, number>();
  private cacheBytes = 0;
  private writeQueued = false;
  private retain(key: string, value: Snapshot) {
    this.evict(key);
    this.cache.set(key, value);
    const weight = Buffer.byteLength(JSON.stringify(value));
    this.weights.set(key, weight);
    this.cacheBytes += weight;
    while (this.cache.size > 64 || this.cacheBytes > 8 * 1048576)
      this.evict(this.cache.keys().next().value!);
  }
  private evict(key: string) {
    this.cache.delete(key);
    this.cacheBytes -= this.weights.get(key) ?? 0;
    this.weights.delete(key);
  }
  private pending = new Map<string, Promise<Snapshot>>();
  private registered = new Map<string, Ref>();
  private choices = new Map<string, EnvironmentChoice>();
  private generation = 0;
  private writes = Promise.resolve();
  private closed = false;
  constructor(
    private endpoints: Endpoints,
    private storage: string,
    private profile: Profiler,
  ) {}
  async init() {
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(this.storage, "inspect.json"), "utf8"),
      );
      for (const [key, value] of saved.choices ?? []) {
        const [endpoint, path] = JSON.parse(key);
        this.choices.set(this.choiceKey({ endpoint, path }), value);
      }
      for (const ref of saved.projects ?? [])
        this.registered.set(refKey(ref), ref);
      for (const [key, value] of (saved.snapshots ?? []).slice(-64))
        this.retain(key, value);
    } catch (error: any) {
      if (error.code !== "ENOENT")
        this.profile.record("inspect.restore", { error: String(error) });
    }
  }
  private persist() {
    if (this.writeQueued) return;
    this.writeQueued = true;
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        this.writeQueued = false;
        const data = JSON.stringify({
          projects: [...this.registered.values()],
          choices: [...this.choices],
          snapshots: [...this.cache],
        });
        const file = path.join(this.storage, "inspect.json");
        await fs.writeFile(file + ".tmp", data, { mode: 0o600 });
        await fs.rename(file + ".tmp", file);
      });
    void this.writes.catch((error) =>
      this.profile.record("inspect.persist", { error: String(error) }),
    );
  }
  private query(
    key: string,
    refresh: boolean,
    run: () => Promise<any>,
  ): Promise<Snapshot> {
    const current = this.pending.get(key);
    if (current) return current;
    const saved = this.cache.get(key);
    if (saved && !refresh) return Promise.resolve(saved);
    const generation = this.generation;
    const promise = this.profile
      .time("inspect.query", { key }, run)
      .then((value) => {
        const result = { stamp: Date.now(), value };
        if (!this.closed && generation === this.generation) {
          this.retain(key, result);
          this.persist();
        }
        return result;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
  invalidate(endpoint: string) {
    this.generation++;
    for (const key of this.pending.keys())
      if (JSON.parse(key)[1] === endpoint) this.pending.delete(key);
    const before = this.cache.size;
    for (const key of this.cache.keys())
      if (JSON.parse(key)[1] === endpoint) this.evict(key);
    if (before !== this.cache.size) this.persist();
  }
  rememberUsage(ref: Ref, value: any) {
    const key = JSON.stringify(["usage", ref.endpoint, ref.path]);
    this.retain(key, { stamp: Date.now(), value });
    this.persist();
  }
  stats() {
    return {
      snapshots: this.cache.size,
      snapshotBytes: this.cacheBytes,
      pending: this.pending.size,
      projects: this.registered.size,
      environmentChoices: this.choices.size,
    };
  }
  projects(endpoint?: string) {
    return [...this.registered.values()].filter(
      (r) => !endpoint || r.endpoint === endpoint,
    );
  }
  register(ref: Ref, remove = false) {
    if (remove) this.registered.delete(refKey(ref));
    else this.registered.set(refKey(ref), ref);
    this.persist();
    return this.projects();
  }
  async detail(ref: Ref, refresh = false) {
    const snapshot = await this.query(
      JSON.stringify(["detail", ref.endpoint, ref.path]),
      refresh,
      async () => {
        const e = this.endpoints.get(ref.endpoint);
        const entry = await e.call("stat", { path: ref.path });
        if (e.config.kind === "windows" && entry.kind === "symlink")
          Object.assign(entry, await e.call("linkInfo", { path: ref.path }));
        const value: any = {
          ref,
          endpoint: e.config,
          entry,
          markers: [],
          tags: [],
          locations: [],
        };
        if (entry.kind === "directory") {
          const pp = pathApi(e.config);
          // Fixed set of immediate child names. Manifest content and secrets stay unread.
          const names = Object.keys(markers);
          const found: any[] = await e.call("statMany", {
            paths: names.map((name) => pp.join(ref.path, name)),
          });
          value.markers = names.flatMap((name, i) =>
            found[i]?.kind
              ? [
                  {
                    name,
                    tag: markers[name],
                    ref: {
                      endpoint: ref.endpoint,
                      path: pp.join(ref.path, name),
                    },
                    kind: found[i].kind,
                  },
                ]
              : [],
          );
          value.tags = [
            ...new Set(value.markers.map((m: any) => m.tag).filter(Boolean)),
          ];
          const info = await e.call("info");
          const candidates: [string, string][] = [
            ["uv 缓存", pp.join(info.home, ".cache", "uv")],
            ["pip 缓存", pp.join(info.home, ".cache", "pip")],
            ["npm 缓存", pp.join(info.home, ".npm")],
            [
              "Gradle 缓存",
              pp.join(
                info.paths?.GRADLE_USER_HOME ?? pp.join(info.home, ".gradle"),
                "caches",
              ),
            ],
            ["Maven 仓库", pp.join(info.home, ".m2", "repository")],
            ["Cargo", pp.join(info.home, ".cargo")],
            [
              "Rust 工具链",
              info.paths?.RUSTUP_HOME || pp.join(info.home, ".rustup"),
            ],
            [
              "Android SDK",
              info.paths?.ANDROID_SDK_ROOT ||
                info.paths?.ANDROID_HOME ||
                pp.join(
                  info.home,
                  e.config.kind === "windows" ? "AppData" : "Android",
                  e.config.kind === "windows" ? "Local\\Android\\Sdk" : "Sdk",
                ),
            ],
          ];
          candidates.push(
            ["Android SDK", pp.join(info.home, "Android")],
            [
              "Flutter SDK",
              info.paths?.FLUTTER_ROOT || pp.join(info.home, "flutter"),
            ],
          );
          for (const key of [
            "JAVA_HOME",
            "FLUTTER_ROOT",
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
          ])
            if (info.paths?.[key]) candidates.push([key, info.paths[key]]);
          for (const marker of value.markers)
            if (marker.tag?.includes("environment"))
              candidates.push([marker.tag, marker.ref.path]);
          if (e.config.kind === "windows")
            candidates.push(
              [
                "uv 缓存",
                pp.join(info.home, "AppData", "Local", "uv", "cache"),
              ],
              [
                "pip 缓存",
                pp.join(info.home, "AppData", "Local", "pip", "Cache"),
              ],
              ["npm 缓存", pp.join(info.home, "AppData", "Local", "npm-cache")],
            );
          const locations = [
            ...new Map(
              candidates.map(([label, target]) => [
                target,
                [label, target] as [string, string],
              ]),
            ).values(),
          ];
          const foundLocations: any[] = await e.call("statMany", {
            paths: locations.map(([, target]) => target),
          });
          value.locations = locations.flatMap(([label, target], i) =>
            foundLocations[i]?.kind
              ? [
                  {
                    label,
                    ref: { endpoint: ref.endpoint, path: target },
                    kind: foundLocations[i].kind,
                  },
                ]
              : [],
          );
        }
        return value;
      },
    );
    return {
      ...snapshot,
      usage: this.cache.get(JSON.stringify(["usage", ref.endpoint, ref.path])),
      inventory: this.cache.get(
        JSON.stringify(["inventory", ref.endpoint, ref.path]),
      ),
      registered: this.registered.has(refKey(ref)),
    };
  }
  private choiceKey(ref: Ref) {
    const config = this.endpoints.configs().find((c) => c.id === ref.endpoint);
    const normal = config ? pathApi(config).normalize(ref.path) : ref.path;
    return JSON.stringify([
      ref.endpoint,
      config?.kind === "windows" ? normal.toLowerCase() : normal,
    ]);
  }
  environment(ref: Ref, refresh = false) {
    return this.query(
      JSON.stringify(["environment", ref.endpoint, ref.path]),
      refresh,
      () =>
        projectEnvironment(
          this.endpoints.get(ref.endpoint),
          ref,
          this.choices.get(this.choiceKey(ref)),
        ),
    );
  }
  async selectEnvironment(ref: Ref, choice: EnvironmentChoice) {
    const e = this.endpoints.get(ref.endpoint),
      pp = pathApi(e.config);
    for (const [key, value] of Object.entries(choice)) {
      if (
        !["python", "uv", "node", "java"].includes(key) ||
        typeof value !== "string" ||
        !pp.isAbsolute(value)
      )
        throw Error("选择端点上的绝对工具路径");
      const entry = await e.call("stat", { path: value });
      if (
        entry.kind !== "file" &&
        !(entry.kind === "symlink" && entry.targetKind === "file")
      )
        throw Error("工具路径不是可用文件: " + value);
    }
    this.choices.set(this.choiceKey(ref), choice);
    this.invalidate(ref.endpoint);
    this.persist();
    return this.environment(ref, true);
  }
  discovery(endpoint: string, cwd?: string, refresh = false) {
    return this.query(
      JSON.stringify(["discovery", endpoint, cwd ?? ""]),
      refresh,
      () => discover(this.endpoints.get(endpoint), cwd),
    );
  }
  async inventory(ctx: JobContext) {
    const { endpoint, cwd, refresh, ecosystem } = ctx.job.input;
    const snapshot = await this.query(
      JSON.stringify([
        "inventory",
        endpoint,
        cwd ?? "",
        ...(ecosystem ? [ecosystem] : []),
      ]),
      !!refresh,
      async () => {
        const e = this.endpoints.get(endpoint),
          info = await e.call("info");
        ctx.check();
        const found = (
          await this.discovery(endpoint, cwd, !!refresh)
        ).value.map((tool: any) => {
          const choice = cwd
            ? this.choices.get(this.choiceKey({ endpoint, path: cwd }))
            : undefined;
          return {
            ...tool,
            path:
              choice?.[tool.name as keyof EnvironmentChoice] ??
              (tool.name === "python3" || tool.name === "python"
                ? choice?.python
                : undefined) ??
              tool.path,
          };
        });
        const declared = cwd
          ? await this.environment({ endpoint, path: cwd }, !!refresh)
          : undefined;
        const selectedPython = declared?.value.python.selectedPython;
        if (selectedPython)
          found.push({ name: "project-python", path: selectedPython });
        const chosen = cwd
          ? this.choices.get(this.choiceKey({ endpoint, path: cwd }))
          : undefined;
        for (const name of ["uv", "node", "java"] as const)
          if (chosen?.[name] && !found.some((t: any) => t.name === name))
            found.push({ name, path: chosen[name] });
        const tools = [];
        for (const tool of found.filter(
          (t: any) =>
            !ecosystem ||
            (
              {
                python: [
                  "project-python",
                  "uv",
                  "python",
                  "python3",
                  ".venv/bin/python",
                  ".venv/Scripts/python.exe",
                ],
                node: ["node", "npm", "pnpm", "bun"],
                java: [
                  "java",
                  "gradle",
                  "mvn",
                  "gradlew",
                  "gradlew.bat",
                  "mvnw",
                  "mvnw.cmd",
                ],
                android: ["sdkmanager", "flutter"],
                rust: ["rustup", "cargo"],
              } as Record<string, string[]>
            )[ecosystem]?.includes(t.name),
        )) {
          ctx.check();
          ctx.progress({ progress: tool.name });
          const started = performance.now();
          const args =
            versions[tool.name] ??
            (tool.name.includes("python") ? ["--version"] : undefined);
          const argv = args ? [tool.path, ...args] : undefined;
          let result: any = { ...tool, argv, cwd, endpoint };
          if (argv) {
            let command: any;
            try {
              command = await e.call("execStart", {
                argv,
                cwd: cwd ?? info.home,
              });
              try {
                let output = "";
                for (;;) {
                  ctx.check();
                  const status = await e.call("execPoll", { id: command.id });
                  output = (output + (status.output ?? "")).slice(-16384);
                  if (status.code !== null) {
                    result = { ...result, output, exitCode: status.code };
                    break;
                  }
                  await new Promise((r) => setTimeout(r, 200));
                }
              } catch (error) {
                await e.call("execCancel", { id: command.id }).catch(() => {});
                throw error;
              }
            } catch (error) {
              ctx.check();
              result = { ...result, error: String(error) };
            }
          }
          result.ms = performance.now() - started;
          this.profile.record("inspect.tool", {
            endpoint,
            cwd,
            name: tool.name,
            ms: result.ms,
            exitCode: result.exitCode,
            error: result.error,
          });
          tools.push(result);
          ctx.progress({ files: tools.length });
        }
        const projects = [];
        for (const ref of cwd
          ? [{ endpoint, path: cwd }]
          : this.projects(endpoint)) {
          ctx.check();
          try {
            const { stamp, value, registered } = await this.detail(
              ref,
              !!refresh,
            );
            projects.push({ stamp, value, registered });
          } catch (error) {
            projects.push({ ref, error: String(error) });
          }
        }
        return {
          endpoint,
          cwd,
          info,
          tools,
          projects,
          environment: cwd
            ? await this.environment({ endpoint, path: cwd }, !!refresh)
            : undefined,
        };
      },
    );
    return snapshot;
  }
  async dispose() {
    this.closed = true;
    await this.writes;
    this.cache.clear();
    this.weights.clear();
    this.cacheBytes = 0;
    this.registered.clear();
    this.choices.clear();
  }
}
