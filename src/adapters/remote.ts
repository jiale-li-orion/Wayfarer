import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Endpoint, EndpointConfig } from "../shared/types";
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export class RemoteEndpoint implements Endpoint {
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private opening?: Promise<void>;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private stderr = "";
  constructor(
    public config: EndpointConfig,
    private helperPath: string,
    private log: (s: string) => void = () => {},
  ) {}
  get connected() {
    return !!this.child;
  }
  private async open() {
    if (this.closed) throw Error("Endpoint connection closed");
    if (this.child) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const source = await fs.readFile(this.helperPath, "utf8");
      if (this.closed) throw Error("Endpoint connection closed");
      const launcher =
        "import base64;exec(compile(base64.b64decode(" +
        JSON.stringify(Buffer.from(source).toString("base64")) +
        '),"<workspace-map>","exec"))';
      const python = this.config.python ?? "python3";
      let command: string, args: string[];
      if (this.config.kind === "wsl") {
        command = "wsl.exe";
        args = [
          "-d",
          this.config.distro!,
          "--exec",
          python,
          "-u",
          "-c",
          launcher,
        ];
      } else {
        const ssh = [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=2",
        ];
        if (this.config.sshConfig) ssh.push("-F", this.config.sshConfig);
        ssh.push(
          this.config.host!,
          shellQuote(python) + " -u -c " + shellQuote(launcher),
        );
        if (process.platform === "win32" && this.config.distro) {
          command = "wsl.exe";
          args = ["-d", this.config.distro, "--exec", "ssh", ...ssh];
        } else {
          command = "ssh";
          args = ssh;
        }
      }
      const child = spawn(command, args, { stdio: "pipe", windowsHide: true });
      this.child = child;
      this.stderr = "";
      child.stderr.on("data", (b) => {
        this.stderr = (this.stderr + b.toString()).slice(-8192);
      });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const v = JSON.parse(line);
          const p = this.pending.get(v.id);
          if (!p) return;
          this.pending.delete(v.id);
          if (v.error)
            p.reject(
              Object.assign(Error(v.error.message), {
                code: v.error.code,
                type: v.error.type,
              }),
            );
          else p.resolve(v.result);
        } catch (e) {
          this.log("endpoint protocol: " + String(e));
        }
      });
      const fail = (e: Error) => {
        if (this.child !== child) {
          lines.close();
          return;
        }
        this.child = undefined;
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        lines.close();
      };
      child.stdin.on("error", fail);
      child.on("error", fail);
      child.on("exit", (code) =>
        fail(
          Error("Endpoint disconnected (" + code + "): " + this.stderr.trim()),
        ),
      );
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
  async call<T = any>(
    method: string,
    args: Record<string, any> = {},
  ): Promise<T> {
    await this.open();
    if (this.closed || !this.child) throw Error("Endpoint connection closed");
    const child = this.child!;
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, args }) + "\n", (e) => {
        if (e) {
          this.pending.delete(id);
          reject(e);
        }
      });
    });
  }
  dispose() {
    this.closed = true;
    const c = this.child;
    this.child = undefined;
    c?.stdin.end();
    setTimeout(() => c?.kill(), 1500).unref();
    for (const p of this.pending.values()) p.reject(Error("Endpoint closed"));
    this.pending.clear();
  }
}
