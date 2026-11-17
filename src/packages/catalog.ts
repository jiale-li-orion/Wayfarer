import type { Endpoint } from "../shared/types";
export type PackageInput = {
  endpoint: string;
  cwd: string;
  manager: string;
  action: string;
  packages?: string[];
  executable?: string;
  python?: string;
  source?: string;
  channel?: string;
  entry?: string;
  cacheRoot?: string;
};
export interface Recipe {
  argv: string[];
  cwd: string;
  source: string;
  mutating: boolean;
}
export const capabilities: Record<string, string[]> = {
  uv: [
    "environments",
    "list",
    "install",
    "uninstall",
    "update",
    "tools",
    "tool-install",
    "tool-uninstall",
    "tool-update",
    "cache-info",
    "cache-prune",
    "cache-clean",
  ],
  pip: ["environments", "list", "install", "uninstall", "update"],
  npm: [
    "list",
    "global-list",
    "install",
    "uninstall",
    "update",
    "global-install",
    "global-uninstall",
    "global-update",
    "cache-info",
    "cache-clean",
  ],
  pnpm: [
    "list",
    "global-list",
    "install",
    "uninstall",
    "update",
    "global-install",
    "global-uninstall",
    "global-update",
    "cache-info",
    "cache-clean",
  ],
  bun: [
    "list",
    "global-list",
    "install",
    "uninstall",
    "update",
    "global-install",
    "global-uninstall",
    "global-update",
    "cache-info",
    "cache-clean",
  ],
  java: ["info"],
  gradle: ["info", "cache-info", "cache-clean-entry"],
  maven: ["info", "cache-info", "cache-clean-entry"],
  android: ["list", "install", "uninstall", "update"],
  flutter: ["info", "channel", "upgrade", "precache", "dependencies"],
  rustup: ["list", "install", "uninstall", "update"],
  cargo: ["list", "install", "uninstall", "update"],
  winget: ["list", "install", "uninstall", "update"],
};
export type PackageField =
  | "packages"
  | "python"
  | "executable"
  | "source"
  | "channel"
  | "entry"
  | "cacheRoot";
export function fieldsFor(manager: string, action: string): PackageField[] {
  if (["gradle", "maven"].includes(manager) && action.startsWith("cache-"))
    return action === "cache-clean-entry"
      ? ["entry", "cacheRoot"]
      : ["cacheRoot"];
  const fields: PackageField[] = ["executable"];
  if (
    /install|uninstall|update/.test(action) ||
    (manager === "uv" && action === "cache-clean")
  )
    fields.unshift("packages");
  if (
    manager === "pip" ||
    (manager === "uv" &&
      ["list", "install", "uninstall", "update"].includes(action))
  )
    fields.push("python");
  if (
    ["pip", "uv", "npm", "pnpm", "bun", "winget"].includes(manager) &&
    /install|update/.test(action) &&
    !action.includes("uninstall")
  )
    fields.push("source");
  if (manager === "flutter" && action === "channel") fields.push("channel");
  return fields;
}
export function recipe(i: PackageInput): Recipe {
  if (!capabilities[i.manager]?.includes(i.action))
    throw Error("Unsupported package action");
  const applicable = fieldsFor(i.manager, i.action);
  for (const key of [
    "packages",
    "python",
    "executable",
    "source",
    "channel",
    "entry",
    "cacheRoot",
  ] as PackageField[]) {
    const value = i[key];
    if (
      value !== undefined &&
      value !== "" &&
      (!Array.isArray(value) || value.length) &&
      !applicable.includes(key)
    )
      throw Error(key + " does not apply to " + i.manager + " " + i.action);
  }
  const packages = i.packages ?? [];
  for (const p of packages)
    if (!p || p.startsWith("-") || /[\x00\r\n]/.test(p))
      throw Error("Invalid package argument");
  const required = [
    "install",
    "uninstall",
    "update",
    "global-install",
    "global-uninstall",
    "global-update",
    "tool-install",
    "tool-uninstall",
    "tool-update",
  ];
  if (required.includes(i.action) && !packages.length)
    throw Error("Select explicit packages/tools");
  let cmd =
    i.executable ??
    (
      { maven: "mvn", android: "sdkmanager", java: "java" } as Record<
        string,
        string
      >
    )[i.manager] ??
    i.manager;
  let args: string[] = [];
  const a = i.action;
  const env = i.python ? ["--python", i.python] : [];
  switch (i.manager) {
    case "uv":
      args = (
        {
          environments: ["python", "list"],
          list: ["pip", "list", ...env],
          install: ["pip", "install", ...env, ...packages],
          uninstall: ["pip", "uninstall", ...env, ...packages],
          update: ["pip", "install", "--upgrade", ...env, ...packages],
          tools: ["tool", "list"],
          "tool-install": ["tool", "install", ...packages],
          "tool-uninstall": ["tool", "uninstall", ...packages],
          "tool-update": ["tool", "upgrade", ...packages],
          "cache-info": ["cache", "dir"],
          "cache-prune": ["cache", "prune"],
          "cache-clean": ["cache", "clean", ...packages],
        } as Record<string, string[]>
      )[a];
      break;
    case "pip":
      cmd = i.python ?? i.executable ?? "python3";
      args = [
        "-m",
        "pip",
        ...(
          {
            environments: ["--version"],
            list: ["list"],
            install: ["install", ...packages],
            uninstall: ["uninstall", "-y", ...packages],
            update: ["install", "--upgrade", ...packages],
          } as Record<string, string[]>
        )[a],
      ];
      break;
    case "npm":
    case "pnpm":
    case "bun": {
      const global = a.startsWith("global-");
      const action = a.replace("global-", "");
      if (a === "cache-info")
        args =
          i.manager === "npm"
            ? ["config", "get", "cache"]
            : i.manager === "pnpm"
              ? ["store", "path"]
              : ["pm", "cache"];
      else if (a === "cache-clean")
        args =
          i.manager === "npm"
            ? ["cache", "clean", "--force"]
            : i.manager === "pnpm"
              ? ["store", "prune"]
              : ["pm", "cache", "rm"];
      else if (i.manager === "npm")
        args = [
          action === "list" ? "ls" : action,
          ...(global ? ["--global"] : []),
          ...(action === "list" ? ["--depth=0"] : []),
          ...packages,
        ];
      else if (i.manager === "pnpm")
        args = [
          action === "install"
            ? "add"
            : action === "uninstall"
              ? "remove"
              : action,
          ...(global ? ["--global"] : []),
          ...packages,
        ];
      else
        args =
          action === "list"
            ? ["pm", "ls", ...(global ? ["-g"] : [])]
            : [
                action === "install"
                  ? "add"
                  : action === "uninstall"
                    ? "remove"
                    : action,
                ...(global ? ["-g"] : []),
                ...packages,
              ];
      break;
    }
    case "java":
      args = ["-version"];
      break;
    case "gradle":
    case "maven":
      args = ["--version"];
      break;
    case "android":
      args =
        a === "list"
          ? ["--list"]
          : a === "install"
            ? packages
            : a === "uninstall"
              ? ["--uninstall", ...packages]
              : ["--install", ...packages];
      break;
    case "flutter":
      args = (
        {
          info: ["--version"],
          channel: i.channel ? ["channel", i.channel] : ["channel"],
          upgrade: ["upgrade"],
          precache: ["precache"],
          dependencies: ["pub", "get"],
        } as Record<string, string[]>
      )[a];
      break;
    case "rustup":
      args = ["toolchain", a === "list" ? "list" : a, ...packages];
      if (a === "update") args = ["update", ...packages];
      break;
    case "cargo":
      args =
        a === "list"
          ? ["install", "--list"]
          : [
              a === "update" ? "install" : a,
              ...(a === "update" ? ["--force"] : []),
              ...packages,
            ];
      break;
    case "winget":
      args =
        a === "list"
          ? ["list"]
          : [
              a === "update" ? "upgrade" : a,
              "--id",
              packages[0],
              "--exact",
              "--disable-interactivity",
            ];
      if (packages.length > 1)
        throw Error("winget operates on one exact package id per task");
      break;
  }
  if (i.source) {
    if (i.manager === "pip" || i.manager === "uv") {
      if (!/^https?:\/\//.test(i.source))
        throw Error("Package index must be HTTP(S)");
      args.push("--index-url", i.source);
    } else if (["npm", "pnpm", "bun"].includes(i.manager)) {
      if (!/^https?:\/\//.test(i.source))
        throw Error("Registry must be HTTP(S)");
      args.push("--registry", i.source);
    } else if (i.manager === "winget") args.push("--source", i.source);
    else throw Error("This manager uses its configured source");
  }
  if (i.channel && !/^[a-zA-Z0-9_-]+$/.test(i.channel))
    throw Error("Invalid channel");
  if (i.action === "cache-info" && ["gradle", "maven"].includes(i.manager))
    return {
      argv: [
        "filesystem.size",
        i.cacheRoot ??
          (i.manager === "gradle" ? "~/.gradle/caches" : "~/.m2/repository"),
      ],
      cwd: i.cwd,
      source: "选定端点的缓存目录",
      mutating: false,
    };
  if (i.action === "cache-clean-entry")
    return {
      argv: ["delete-cache-entry", i.entry ?? ""],
      cwd: i.cwd,
      source: "选定缓存目录",
      mutating: true,
    };
  return {
    argv: [cmd, ...args],
    cwd: i.cwd,
    source: i.source ?? "当前环境中管理器已配置的源",
    mutating: ![
      "environments",
      "list",
      "global-list",
      "tools",
      "info",
      "cache-info",
    ].includes(a),
  };
}
export async function discover(e: Endpoint, cwd?: string) {
  const names = [
    "uv",
    "node",
    "python3",
    "python",
    "npm",
    "pnpm",
    "bun",
    "java",
    "gradle",
    "mvn",
    "sdkmanager",
    "flutter",
    "rustup",
    "cargo",
    "winget",
  ];
  const found = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, path: await e.call("which", { name }) };
      } catch {
        return { name, path: null };
      }
    }),
  );
  const available = found.filter((x) => x.path);
  if (cwd) {
    const separator = e.config.kind === "windows" ? "\\" : "/";
    for (const name of [
      "gradlew",
      "gradlew.bat",
      "mvnw",
      "mvnw.cmd",
      ".venv/bin/python",
      ".venv/Scripts/python.exe",
    ]) {
      const p = cwd.replace(/[\\\\/]$/, "") + separator + name;
      try {
        const s = await e.call("stat", { path: p });
        if (s.kind === "file") available.push({ name, path: p });
      } catch {}
    }
  }
  return available;
}
