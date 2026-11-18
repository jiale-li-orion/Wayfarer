import { parse } from "smol-toml";
import type { Endpoint, Ref } from "../shared/types";
import { pathApi } from "../shared/paths";

export type EnvironmentChoice = {
  python?: string;
  uv?: string;
  node?: string;
  java?: string;
};
const safe = (v: unknown) =>
  typeof v === "string"
    ? v.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 500)
    : undefined;
/** Fixed-name reads only; return selected declarations, never full manifests or arbitrary environment. */
export async function projectEnvironment(
  e: Endpoint,
  ref: Ref,
  choice: EnvironmentChoice = {},
) {
  const pp = pathApi(e.config),
    win = e.config.kind === "windows";
  const names = [
    "pyproject.toml",
    "uv.lock",
    "requirements.txt",
    "requirements.in",
    ".python-version",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "yarn.lock",
    "gradlew",
    "gradlew.bat",
    "mvnw",
    "mvnw.cmd",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradle/wrapper/gradle-wrapper.properties",
    "venv/pyvenv.cfg",
    ".venv/pyvenv.cfg",
    ".venv/conda-meta",
    "venv/conda-meta",
  ];
  const paths = names.map((n) => pp.join(ref.path, n));
  const stats: any[] = await e.call("statMany", { paths });
  const exists = new Map(
    names.map((n, i) => [
      n,
      stats[i]?.kind && stats[i].kind !== "denied" ? stats[i] : undefined,
    ]),
  );
  const errors: { file: string; error: string }[] = [];
  const text = async (name: string) => {
    const s = exists.get(name);
    if (!s || s.kind !== "file") return undefined;
    if (s.size > 256 * 1024) {
      errors.push({ file: name, error: "清单超过 256 KiB；可在编辑器查看" });
      return;
    }
    try {
      return Buffer.from(
        await e.call<string>("read", {
          path: pp.join(ref.path, name),
          offset: 0,
          length: 256 * 1024,
        }),
        "base64",
      ).toString("utf8");
    } catch (error) {
      errors.push({ file: name, error: String(error) });
    }
  };
  let py: any, node: any;
  try {
    const raw = await text("pyproject.toml");
    if (raw) py = parse(raw);
  } catch (error) {
    errors.push({ file: "pyproject.toml", error: String(error) });
  }
  try {
    const raw = await text("package.json");
    if (raw) node = JSON.parse(raw);
  } catch (error) {
    errors.push({ file: "package.json", error: String(error) });
  }
  const info: any = await e.call("info");
  const candidates = [
    choice.python,
    ...[".venv", "venv"].map((n) =>
      pp.join(ref.path, n, win ? "Scripts/python.exe" : "bin/python"),
    ),
    ...(info.paths?.VIRTUAL_ENV
      ? [
          pp.join(
            info.paths.VIRTUAL_ENV,
            win ? "Scripts/python.exe" : "bin/python",
          ),
        ]
      : []),
    ...(info.paths?.CONDA_PREFIX
      ? [pp.join(info.paths.CONDA_PREFIX, win ? "python.exe" : "bin/python")]
      : []),
  ].filter(Boolean) as string[];
  const unique = [...new Set(candidates)];
  const envStats: any[] = unique.length
    ? await e.call("statMany", { paths: unique })
    : [];
  const interpreters = unique.flatMap((p, i) => {
    const s = envStats[i];
    return s &&
      (s.kind === "file" || (s.kind === "symlink" && s.targetKind === "file"))
      ? [
          {
            path: p,
            resolved: s.resolved,
            source:
              p === choice.python
                ? "Wayfarer 项目选择"
                : p.startsWith(ref.path + pp.sep)
                  ? "项目环境目录"
                  : "端点进程环境",
            selected: p === choice.python,
          },
        ]
      : [];
  });
  const projectInterpreters = interpreters.filter(
    (p) => p.source === "项目环境目录",
  );
  const selectedPython = choice.python
    ? interpreters.find((p) => p.path === choice.python)?.path
    : projectInterpreters.length === 1
      ? projectInterpreters[0].path
      : undefined;
  const dependencies = (value: any, group: string) =>
    Array.isArray(value)
      ? value
          .slice(0, 300)
          .map((v: any) => ({ group, declaration: safe(v) }))
          .filter((v: any) => v.declaration)
      : [];
  const nodeDeps = (value: any, group: string) =>
    value && typeof value === "object"
      ? Object.entries(value)
          .slice(0, 300)
          .map(([name, v]) => ({ name, declaration: safe(v), group }))
      : [];
  const wrappers = names
    .filter((n) => /^(gradlew|mvnw)/.test(n) && exists.get(n))
    .map((n) => pp.join(ref.path, n));
  const pythonPin = safe((await text(".python-version"))?.trim());
  const requirements =
    (await text("requirements.txt"))
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) => line && !line.startsWith("#") && !line.startsWith("-"),
      ) ?? [];
  const uvProject = !!py && !!(py.project || py.tool?.uv);
  const uvWorkspace = py?.tool?.uv?.workspace?.members;
  return {
    ref,
    choice,
    errors,
    python: {
      manager: "uv",
      project: uvProject,
      lock: exists.get("uv.lock") ? pp.join(ref.path, "uv.lock") : undefined,
      name: safe(py?.project?.name),
      requiresPython: safe(py?.project?.["requires-python"]),
      versionFile: pythonPin,
      interpreters,
      selectedPython,
      selectionMissing: !!choice.python && !selectedPython,
      declarations: [
        ...dependencies(py?.project?.dependencies, "dependencies"),
        ...dependencies(requirements, "requirements.txt"),
        ...Object.entries(py?.["dependency-groups"] ?? {}).flatMap(([g, v]) =>
          dependencies(v, g),
        ),
      ],
      workspaceMembers: Array.isArray(uvWorkspace)
        ? uvWorkspace.map(safe).filter(Boolean).slice(0, 100)
        : [],
      manifests: [
        "pyproject.toml",
        "uv.lock",
        ".python-version",
        "requirements.txt",
        "requirements.in",
      ]
        .filter((n) => exists.get(n))
        .map((n) => pp.join(ref.path, n)),
    },
    node: {
      name: safe(node?.name),
      manager: safe(node?.packageManager),
      engines: Object.fromEntries(
        Object.entries(node?.engines ?? {}).map(([k, v]) => [k, safe(v)]),
      ),
      locks: [
        "package-lock.json",
        "pnpm-lock.yaml",
        "bun.lock",
        "bun.lockb",
        "yarn.lock",
      ].filter((n) => exists.get(n)),
      declarations: [
        ...nodeDeps(node?.dependencies, "dependencies"),
        ...nodeDeps(node?.devDependencies, "devDependencies"),
      ],
      manifest: node ? pp.join(ref.path, "package.json") : undefined,
    },
    java: {
      javaHome: info.paths?.JAVA_HOME,
      selectedJava: choice.java,
      wrappers,
      manifests: [
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "gradle/wrapper/gradle-wrapper.properties",
      ]
        .filter((n) => exists.get(n))
        .map((n) => pp.join(ref.path, n)),
    },
    detectedAt: Date.now(),
    source: "项目声明与端点路径；实际版本、已安装依赖按需查询",
  };
}
