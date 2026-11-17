import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { closeChild, grace, EXIT_GRACE_MS } from "../core/lifecycle";
import type { Core } from "../core/core";
import type { EndpointConfig } from "../shared/types";
export class Bridge {
  readonly id = randomUUID();
  private closed = false;
  private closing?: Promise<void>;
  private starting?: Promise<void>;
  private clients = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  stats() {
    return {
      id: this.id,
      mapId: this.mapId,
      state: this.closed ? "closing" : "running",
      clients: this.clients.size,
      subscriptions: this.clients.size,
      pendingRequests: this.pending.size,
      relays: this.children.length,
    };
  }

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
    readonly mapId: string = randomUUID(),
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
  start() {
    return (this.starting ??= this.launch());
  }
  private async launch() {
    this.core.on("event", this.event);
    const targets =
      process.platform === "win32"
        ? this.core.endpoints.configs().filter((e) => e.kind === "wsl")
        : [this.core.endpoints.configs().find((e) => e.kind === "local")!];
    for (const target of targets) {
      try {
        if (this.closed) break;
        const e = this.core.endpoints.get(target.id);
        const info = await e.call("info");
        const files = await Promise.all(
          ["mcp.py", "tools.json"].map(async (name) => ({
            name,
            data: await fs.readFile(path.join(this.helperDir, name)),
          })),
        );
        const revision = createHash("sha256");
        for (const file of files) revision.update(file.data);
        const dir = path.posix.join(
          info.home,
          ".local/share/workspace-map/client",
          revision.digest("hex").slice(0, 16),
        );
        await e.call("mkdir", { path: dir });
        for (const file of files)
          await e.call("write", {
            path: path.posix.join(dir, file.name),
            data: file.data.toString("base64"),
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
                  this.mapId,
                ],
                { stdio: "pipe", windowsHide: true },
              )
            : spawn(
                "python3",
                ["-u", "-c", launcher, this.id, this.name, this.mapId],
                {
                  stdio: "pipe",
                },
              );
        if (this.closed) {
          c.kill("SIGKILL");
          continue;
        }
        this.children.push(c);
        const owned = new Set<string>();
        c.stderr.on("data", (b) =>
          this.core.profile.record("ipc.stderr", {
            message: b.toString().slice(-8192),
          }),
        );
        const lines = createInterface({ input: c.stdout });
        lines.on("line", (line) => {
          try {
            const m = JSON.parse(line);
            if (m.ready) {
              this.core.profile.record("ipc.ready", m);
              return;
            }
            if (m.clientOpen) {
              if (this.closed) return;
              owned.add(m.clientOpen);
              this.clients.add(m.clientOpen);
              this.core.attachClient(m.clientOpen);
              return;
            }
            if (m.clientClose) {
              owned.delete(m.clientClose);
              this.clients.delete(m.clientClose);
              this.core.releaseClient(m.clientClose);
              return;
            }
            if (this.closed) return;
            const reply = (value: any) => {
              if (!this.closed && owned.has(m.client) && c.stdin.writable)
                c.stdin.write(JSON.stringify({ id: m.id, ...value }) + "\n");
            };
            const request = this.core
              .dispatch(
                m.method,
                m.args,
                "agent",
                m.legacy ? undefined : m.client,
              )
              .then(
                (result) => reply({ result }),
                (err) => reply({ error: String(err) }),
              );
            this.pending.add(request);
            void request.finally(() => this.pending.delete(request));
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
          for (const id of owned) {
            this.clients.delete(id);
            this.core.releaseClient(id);
          }
          owned.clear();
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
      "--map",
      this.mapId,
    ];
    return windows && c.distro
      ? {
          command: "wsl.exe",
          args: ["-d", c.distro, "--exec", "python3", ...args],
        }
      : { command: "python3", args };
  }
  stopIngress() {
    if (this.closed) return;
    this.closed = true;
    this.core.off("event", this.event);
    for (const c of this.children)
      if (c.stdin.writable)
        c.stdin.write(JSON.stringify({ shutdown: true }) + "\n");
    for (const id of this.clients) this.core.releaseClient(id);
    this.clients.clear();
  }
  dispose(deadline = Date.now() + EXIT_GRACE_MS) {
    return (this.closing ??= this.close(deadline));
  }
  private async close(deadline: number) {
    this.stopIngress();
    await this.starting;
    await Promise.all([...this.pending]);
    const children = [...this.children];
    await grace(
      Promise.all(children.map((c) => closeChild(c))),
      () => {
        for (const c of children) void closeChild(c, true);
      },
      Math.max(0, deadline - Date.now()),
    );
    this.children = [];
  }
}
