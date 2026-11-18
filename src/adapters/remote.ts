import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { createInterface } from "node:readline";
import {
  grace,
  closeChild,
  EXIT_GRACE_MS,
  TransportLost,
} from "../core/lifecycle";
import type { Endpoint, EndpointConfig } from "../shared/types";
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export class RemoteEndpoint implements Endpoint {
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private closing?: Promise<void>;
  private retiring = new Set<Promise<void>>();
  private opening?: Promise<void>;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private stderr = "";
  private bulk?: RemoteEndpoint;
  private bulkUsers = 0;
  private lastTransferTransport?: Record<string, number>;
  openTransfer() {
    if (this.closed) throw Error("Endpoint connection closed");
    const bulk = (this.bulk ??= new RemoteEndpoint(
      this.config,
      this.helperPath,
      this.log,
    ));
    this.bulkUsers++;
    let released = false;
    return {
      endpoint: bulk,
      release: () => {
        if (released) return;
        released = true;
        if (this.bulk !== bulk) return;
        if (--this.bulkUsers === 0) {
          this.lastTransferTransport = { ...bulk.metrics };
          this.bulk = undefined;
          const closing = bulk.dispose();
          this.retiring.add(closing);
          void closing.finally(() => this.retiring.delete(closing));
        }
      },
    };
  }
  private metrics = {
    calls: 0,
    failures: 0,
    sentBytes: 0,
    receivedBytes: 0,
    serializeMs: 0,
    parseMs: 0,
    rpcElapsedMs: 0,
    peakPending: 0,
  };
  constructor(
    public config: EndpointConfig,
    private helperPath: string,
    private log: (s: string) => void = () => {},
  ) {}
  transportStats() {
    return { ...this.metrics, pending: this.pending.size };
  }
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
        "import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(" +
        JSON.stringify(deflateSync(Buffer.from(source)).toString("base64")) +
        "))," +
        JSON.stringify(
          this.helperPath.endsWith("monitor.py")
            ? "<workspace-map-monitor>"
            : "<workspace-map>",
        ) +
        ',"exec"))';
      const python = this.config.python ?? "python3";
      let command: string, args: string[];
      if (["local", "windows"].includes(this.config.kind)) {
        command =
          this.config.python ??
          (process.platform === "win32" ? "python" : "python3");
        args = ["-u", "-c", launcher];
      } else if (this.config.kind === "wsl") {
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
          const start = performance.now();
          const v = JSON.parse(line);
          if (
            !v ||
            typeof v !== "object" ||
            typeof v.id !== "number" ||
            (!("result" in v) && !("error" in v))
          )
            throw Error("Invalid endpoint protocol frame");
          this.metrics.parseMs += performance.now() - start;
          this.metrics.receivedBytes += Buffer.byteLength(line) + 1;
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
          fail(new TransportLost("Endpoint returned malformed protocol data"));
          child.kill("SIGKILL");
        }
      });
      const fail = (e: Error) => {
        if (this.child !== child) {
          lines.close();
          return;
        }
        this.child = undefined;
        for (const p of this.pending.values())
          p.reject(new TransportLost(e.message));
        this.pending.clear();
        lines.close();
      };
      child.stdin.on("error", fail);
      child.on("error", fail);
      child.on("exit", (code) =>
        fail(
          new TransportLost(
            "Endpoint disconnected (" + code + "): " + this.stderr.trim(),
          ),
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
    const result = await this.request<T>(method, args);
    if (method !== "resources") return result;
    const bulk = this.bulk;
    return {
      ...result,
      transferUsers: this.bulkUsers,
      retiringHelpers: this.retiring.size,
      lastTransferTransport: this.lastTransferTransport,
      transfer: bulk?.connected
        ? await bulk
            .request("resources")
            .catch((error) => ({ error: String(error) }))
        : undefined,
    } as T;
  }
  private async request<T = any>(
    method: string,
    args: Record<string, any> = {},
  ): Promise<T> {
    await this.open();
    if (this.closed || !this.child)
      throw new TransportLost("Endpoint connection closed");
    const child = this.child!;
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const start = performance.now();
      const frame = JSON.stringify({ id, method, args }) + "\n";
      this.metrics.serializeMs += performance.now() - start;
      this.metrics.sentBytes += Buffer.byteLength(frame);
      this.metrics.calls++;
      this.pending.set(id, {
        resolve: (value) => {
          this.metrics.rpcElapsedMs += performance.now() - start;
          resolve(
            method === "resources"
              ? {
                  ...value,
                  transport: { ...this.metrics, pending: this.pending.size },
                }
              : value,
          );
        },
        reject: (error) => {
          this.metrics.failures++;
          this.metrics.rpcElapsedMs += performance.now() - start;
          reject(error);
        },
      });
      this.metrics.peakPending = Math.max(
        this.metrics.peakPending,
        this.pending.size,
      );
      child.stdin.write(frame, (e) => {
        if (e) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          pending?.reject(new TransportLost(e.message));
        }
      });
    });
  }
  abort() {
    this.bulk?.abort();
    const child = this.child;
    if (child) {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    for (const p of this.pending.values())
      p.reject(new TransportLost("Endpoint interrupted"));
    this.pending.clear();
  }
  dispose(deadline = Date.now() + EXIT_GRACE_MS) {
    return (this.closing ??= this.close(deadline));
  }
  private async close(deadline: number) {
    this.closed = true;
    await this.opening?.catch(() => {});
    const bulk = this.bulk;
    this.bulk = undefined;
    this.bulkUsers = 0;
    const child = this.child;
    const done = Promise.all([
      child ? closeChild(child) : Promise.resolve(),
      bulk?.dispose(deadline),
      ...this.retiring,
    ]);
    await grace(
      done,
      () => {
        this.abort();
        bulk?.abort();
      },
      Math.max(0, deadline - Date.now()),
    );
    this.child = undefined;
    for (const p of this.pending.values())
      p.reject(new TransportLost("Endpoint closed"));
    this.pending.clear();
  }
}
