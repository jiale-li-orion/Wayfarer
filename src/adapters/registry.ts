import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { NativeEndpoint } from "./native";
import { RemoteEndpoint } from "./remote";
import type { Endpoint, EndpointConfig } from "../shared/types";
export class Endpoints {
  readonly items = new Map<string, Endpoint>();
  private disconnected = new Set<string>();
  enabled(id: string) {
    return !this.disconnected.has(id);
  }
  disconnect(id: string) {
    const endpoint = this.get(id);
    if (!["ssh", "wsl"].includes(endpoint.config.kind))
      throw Error("本机文件系统保持可用");
    endpoint.dispose();
    this.disconnected.add(id);
  }
  connect(id: string) {
    const endpoint = this.items.get(id);
    if (!endpoint) throw Error("Unknown endpoint");
    return this.disconnected.has(id) ? this.add(endpoint.config) : endpoint;
  }
  constructor(
    private helper: string,
    private log: (s: string) => void,
    private trash?: (p: string) => Promise<void>,
  ) {}
  add(c: EndpointConfig) {
    if (!/^[a-zA-Z0-9_-]+$/.test(c.id))
      throw Error("Endpoint id must use letters, numbers, _ or -");
    this.items.get(c.id)?.dispose();
    this.disconnected.delete(c.id);
    const e =
      c.kind === "local" || c.kind === "windows"
        ? new NativeEndpoint(c, this.trash)
        : new RemoteEndpoint(c, this.helper, this.log);
    this.items.set(c.id, e);
    return e;
  }
  get(id: string) {
    if (this.disconnected.has(id)) throw Error("端点已断开：" + id);
    const e = this.items.get(id);
    if (!e) throw Error("Unknown endpoint: " + id);
    return e;
  }
  configs() {
    return [...this.items.values()].map((e) => e.config);
  }
  async discover(extra: EndpointConfig[]) {
    if (process.platform === "win32") {
      const drives = await Promise.all(
        Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map(
          async (d) =>
            await fs.stat(d + ":\\").then(
              () => d,
              () => null,
            ),
        ),
      );
      for (const d of drives.filter(Boolean))
        this.add({
          id: "windows-" + d!.toLowerCase(),
          name: "Windows " + d + ":",
          kind: "windows",
          root: d + ":\\",
        });
      const distros = await new Promise<string[]>((resolve) => {
        const c = spawn("wsl.exe", ["--list", "--quiet"], {
          windowsHide: true,
        });
        const chunks: Buffer[] = [];
        c.stdout.on("data", (b) => chunks.push(b));
        c.on("error", () => resolve([]));
        c.on("close", () =>
          resolve(
            Buffer.concat(chunks)
              .toString("utf16le")
              .replaceAll("\0", "")
              .split(/\r?\n/)
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        );
      });
      for (const distro of distros)
        this.add({
          id: "wsl-" + distro.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
          name: distro + " · WSL",
          kind: "wsl",
          root: "/",
          distro,
        });
    } else
      this.add({
        id: "local",
        name: os.hostname(),
        kind: "local",
        root: os.homedir(),
      });
    for (const c of extra) this.add(c);
  }
  dispose() {
    for (const e of this.items.values()) e.dispose();
  }
}
