import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Core } from "../core/core";
import type { EndpointConfig } from "../shared/types";
export class Bridge {
  readonly id = randomUUID();
  private children: ChildProcessWithoutNullStreams[] = [];
  readonly connections: {
    distro?: string;
    session: string;
    helperDir: string;
    endpoint: string;
  }[] = [];
  constructor(
    private core: Core,
    private helperDir: string,
    private name: string,
  ) {}
  private event = (event: any) => {
    if (event.type === "job")
      for (const c of this.children)
        if (c.stdin.writable)
          c.stdin.write(
            JSON.stringify({
              event: {
                type: "job",
                id: event.job.id,
                state: event.job.state,
                bytes: event.job.bytes,
                files: event.job.files,
              },
            }) + "\n",
          );
  };
  async start() {
    this.core.on("event", this.event);
    const targets =
      process.platform === "win32"
        ? this.core.endpoints.configs().filter((e) => e.kind === "wsl")
        : [this.core.endpoints.configs().find((e) => e.kind === "local")!];
    for (const target of targets) {
      try {
        const e = this.core.endpoints.get(target.id);
        const info = await e.call("info");
        const dir = path.posix.join(
          info.home,
          ".local/share/workspace-map/client",
        );
        await e.call("mkdir", { path: dir });
        for (const file of ["mcp.py", "tools.json"])
          await e.call("write", {
            path: path.posix.join(dir, file),
            data: (await fs.readFile(path.join(this.helperDir, file))).toString(
              "base64",
            ),
            offset: 0,
            truncate: true,
          });
        const source = await fs.readFile(
          path.join(this.helperDir, "relay.py"),
          "utf8",
        );
        const launcher =
          "import base64;exec(compile(base64.b64decode(" +
          JSON.stringify(Buffer.from(source).toString("base64")) +
          '),"<workspace-map-relay>","exec"))';
        const c =
          process.platform === "win32"
            ? spawn(
                "wsl.exe",
                [
                  "-d",
                  target.distro!,
                  "--exec",
                  "python3",
                  "-u",
                  "-c",
                  launcher,
                  this.id,
                  this.name,
                ],
                { stdio: "pipe", windowsHide: true },
              )
            : spawn("python3", ["-u", "-c", launcher, this.id, this.name], {
                stdio: "pipe",
              });
        this.children.push(c);
        c.stderr.on("data", (b) =>
          this.core.profile.record("ipc.stderr", { message: b.toString() }),
        );
        const lines = createInterface({ input: c.stdout });
        lines.on("line", (line) => {
          try {
            const m = JSON.parse(line);
            if (m.ready) {
              this.core.profile.record("ipc.ready", m);
              return;
            }
            void this.core.dispatch(m.method, m.args, "agent").then(
              (result) =>
                c.stdin.write(JSON.stringify({ id: m.id, result }) + "\n"),
              (err) =>
                c.stdin.write(
                  JSON.stringify({ id: m.id, error: String(err) }) + "\n",
                ),
            );
          } catch (e) {
            this.core.profile.record("ipc.error", { message: String(e) });
          }
        });
        c.on("error", (e) =>
          this.core.profile.record("ipc.error", { message: String(e) }),
        );
        c.stdin.on("error", (error) =>
          this.core.profile.record("ipc.write", { error: String(error) }),
        );
        c.on("exit", () => {
          lines.close();
          this.children = this.children.filter((child) => child !== c);
        });
        this.connections.push({
          distro: target.distro,
          session: this.id,
          helperDir: dir,
          endpoint: target.id,
        });
      } catch (e) {
        this.core.profile.record("ipc.start", {
          endpoint: target.id,
          error: String(e),
        });
      }
    }
  }
  config(c = this.connections[0], windows = false) {
    if (!c) throw Error("A local or WSL connection is required for MCP");
    const args = [
      "-u",
      path.posix.join(c.helperDir, "mcp.py"),
      "--session",
      c.session,
    ];
    return windows && c.distro
      ? {
          command: "wsl.exe",
          args: ["-d", c.distro, "--exec", "python3", ...args],
        }
      : { command: "python3", args };
  }
  dispose() {
    this.core.off("event", this.event);
    for (const c of this.children) c.stdin.end();
    this.children = [];
  }
}
