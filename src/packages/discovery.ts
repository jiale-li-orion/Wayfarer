import type { Endpoint } from "../shared/types";
import { pathApi } from "../shared/paths";
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
  const info = await e.call("info"),
    pp = pathApi(e.config),
    win = e.config.kind === "windows";
  const sdkRoots = [
    info.paths?.ANDROID_SDK_ROOT,
    info.paths?.ANDROID_HOME,
    pp.join(info.home, "Android", "Sdk"),
    pp.join(info.home, "Android"),
    ...(win ? [pp.join(info.home, "AppData", "Local", "Android", "Sdk")] : []),
  ].filter(Boolean);
  const candidates: Record<string, string[]> = {
    flutter: [
      info.paths?.FLUTTER_ROOT &&
        pp.join(
          info.paths.FLUTTER_ROOT,
          "bin",
          win ? "flutter.bat" : "flutter",
        ),
      pp.join(info.home, "flutter", "bin", win ? "flutter.bat" : "flutter"),
    ].filter(Boolean) as string[],
    sdkmanager: sdkRoots.map((root) =>
      pp.join(
        root,
        "cmdline-tools",
        "latest",
        "bin",
        win ? "sdkmanager.bat" : "sdkmanager",
      ),
    ),
    java: info.paths?.JAVA_HOME
      ? [pp.join(info.paths.JAVA_HOME, "bin", win ? "java.exe" : "java")]
      : [],
  };
  for (const [name, paths] of Object.entries(candidates))
    if (!available.some((tool) => tool.name === name)) {
      for (const target of paths) {
        try {
          const entry = await e.call("stat", { path: target });
          if (
            (entry.kind === "file" ||
              (entry.kind === "symlink" && entry.targetKind === "file")) &&
            (win || entry.mode & 0o111)
          ) {
            available.push({ name, path: target });
            break;
          }
        } catch {}
      }
    }
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
