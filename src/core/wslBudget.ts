import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type WslConfig = {
  invalid?: string[];
  memory?: string;
  processors?: number;
  swap?: string;
  source: "configured" | "default" | "unavailable";
};
export function parseWslBudget(text: string): WslConfig {
  const config: WslConfig = { source: "default" };
  let section = "";
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.split(/[;#]/, 1)[0].trim();
    if (line.startsWith("[")) {
      section = line.toLowerCase();
      continue;
    }
    if (section !== "[wsl2]") continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().toLowerCase(),
      value = line.slice(eq + 1).trim();
    if (
      (key === "memory" || key === "swap") &&
      /^(?:\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB)|0)$/i.test(value)
    )
      config[key] = value.toUpperCase();
    if ((key === "memory" || key === "swap") && !config[key])
      config.invalid = [...(config.invalid ?? []), key];
    if (key === "processors" && /^\d+$/.test(value) && Number(value) > 0)
      config.processors = Number(value);
  }
  if (config.memory || config.processors || config.swap)
    config.source = "configured";
  return config;
}
export class WslBudget {
  private until = 0;
  private saved?: Promise<WslConfig>;
  read(): Promise<WslConfig> {
    if (this.saved && Date.now() < this.until) return this.saved;
    this.until = Date.now() + 10000;
    this.saved = fs.readFile(path.join(os.homedir(), ".wslconfig")).then(
      (b) =>
        parseWslBudget(
          b.toString(b[0] === 255 && b[1] === 254 ? "utf16le" : "utf8"),
        ),
      (e) =>
        ({
          source: e.code === "ENOENT" ? "default" : "unavailable",
        }) as WslConfig,
    );
    return this.saved;
  }
}
