import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
const build = JSON.parse(await fs.readFile("dist/build-info.json", "utf8"));
const artifact = "artifacts/workspace-map.vsix",
  hash = createHash("sha256");
for await (const chunk of createReadStream(artifact)) hash.update(chunk);
const sha256 = hash.digest("hex");
const release = {
  ...build,
  repository: pkg.repository.url,
  artifact: "workspace-map.vsix",
  bytes: (await fs.stat(artifact)).size,
  sha256,
};
await fs.writeFile(artifact + ".sha256", sha256 + "  workspace-map.vsix\n");
await fs.writeFile(
  "artifacts/release.json",
  JSON.stringify(release, null, 2) + "\n",
);
const changes = await fs.readFile("CHANGELOG.md", "utf8");
const section = changes
  .split("## " + pkg.version + "\n")[1]
  ?.split("\n## ")[0]
  ?.trim();
if (!section) throw Error("Add release notes for " + pkg.version);
await fs.writeFile(
  "artifacts/RELEASE.md",
  section +
    "\n\nCommit: `" +
    build.commit +
    "`\n\nSHA-256: `" +
    sha256 +
    "`\n\n实际机器覆盖见仓库 docs/ACCEPTANCE.md，CPU／内存对照见 PERFORMANCE.md。\n",
);
console.log(JSON.stringify(release));
