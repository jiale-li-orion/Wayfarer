import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await mkdir("artifacts", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["src/ui/storage.tsx"],
    outfile: "dist/storage.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    entryPoints: ["src/ui/environment.tsx"],
    outfile: "dist/environment.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    target: "node20",
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/ui/main.tsx"],
    outfile: "dist/ui.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    loader: { ".ttf": "file" },
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    entryPoints: ["src/ui/resources.tsx"],
    outfile: "dist/resources.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    entryPoints: ["src/ui/layout.worker.ts"],
    outfile: "dist/layout.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    target: "es2022",
  }),
]);
await rm("dist/helpers", { recursive: true, force: true });
await cp("helpers", "dist/helpers", {
  recursive: true,
  filter: (source) =>
    !source.includes("__pycache__") && !source.endsWith(".pyc"),
});
await cp("scripts/index-workload.py","dist/helpers/index-workload.py");
const metadata = {
  version: JSON.parse(await readFile("package.json", "utf8")).version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim(),
  builtAt: new Date().toISOString(),
  node: process.version,
};
await writeFile("dist/build-info.json", JSON.stringify(metadata, null, 2));

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const notices = [];
for (const [directory, info] of Object.entries(lock.packages)) {
  if (
    !directory.startsWith("node_modules/") ||
    (info.dev && directory !== "node_modules/@vscode/codicons")
  )
    continue;
  let license;
  for (const name of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "LICENSE-MIT",
    "LICENSE-MIT.txt",
  ]) {
    try {
      license = await readFile(directory + "/" + name, "utf8");
      break;
    } catch {}
  }
  if (license) notices.push(directory + " · " + info.version + "\n" + license);
}
await writeFile(
  "dist/THIRD_PARTY_NOTICES.txt",
  notices.join("\n\n--------------------\n\n"),
);
