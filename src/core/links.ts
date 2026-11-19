import { randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import { RemoteEndpoint } from "../adapters/remote";
import type { Endpoints } from "../adapters/registry";
import type { JobContext } from "./jobs";

type Address = { endpoint: string; address: string };
export type LinkInput = {
  source: Address;
  target: Address;
  measure?: boolean;
  port?: number;
  bytes?: number;
};
type Interface = { device: string; address: string; prefix: number };
type Direction = { bytes: number; elapsedMs: number; bitsPerSecond: number };

export class Links {
  constructor(
    private endpoints: Endpoints,
    private helper: string,
  ) {}

  private config(id: string) {
    const config = this.endpoints.get(id).config;
    if (config.kind !== "ssh") throw Error("链路检查需要已登记的 SSH 主机");
    if (!this.endpoints.enabled(id)) throw Error(config.name + " 已断开");
    return config;
  }

  async interfaces(endpoint: string) {
    const channel = new RemoteEndpoint(this.config(endpoint), this.helper);
    const timer = setTimeout(() => channel.abort(), 12000);
    try {
      return await channel.call<Interface[]>("interfaces");
    } finally {
      clearTimeout(timer);
      await channel.dispose();
    }
  }

  validate(input: LinkInput) {
    if (
      !input.source ||
      !input.target ||
      input.source.endpoint === input.target.endpoint ||
      !isIPv4(input.source.address) ||
      !isIPv4(input.target.address) ||
      input.source.address === input.target.address
    )
      throw Error("请选择两台机器各自的私网地址");
    const source = this.config(input.source.endpoint);
    const target = this.config(input.target.endpoint);
    const port = input.port ?? 22;
    const bytes = input.bytes ?? 64 * 1024 * 1024;
    if (input.measure !== undefined && typeof input.measure !== "boolean")
      throw Error("测速开关无效");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error("TCP 端口无效");
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 128 * 1024 * 1024)
      throw Error("单方向测速最多 128 MiB");
    return { source, target, port, bytes };
  }

  async run(ctx: JobContext) {
    const input = ctx.job.input as LinkInput;
    const { source, target, port, bytes } = this.validate(input);
    const from = new RemoteEndpoint(source, this.helper);
    const to = new RemoteEndpoint(target, this.helper);
    const abort = () => {
      from.abort();
      to.abort();
    };
    const deadline = setTimeout(abort, 24000);
    const watch = setInterval(() => {
      try {
        ctx.check();
        if (
          !this.endpoints.enabled(source.id) ||
          !this.endpoints.enabled(target.id)
        )
          abort();
      } catch {
        abort();
      }
    }, 100);
    const a = { local: input.source.address, peer: input.target.address, port };
    const b = { local: a.peer, peer: a.local, port };
    const started = Date.now();
    try {
      const [interfacesA, interfacesB] = await Promise.all([
        from.call<Interface[]>("interfaces"),
        to.call<Interface[]>("interfaces"),
      ]);
      if (
        !interfacesA.some((v) => v.address === a.local) ||
        !interfacesB.some((v) => v.address === b.local)
      )
        throw Error("所选地址已变化，请刷新网络接口");
      ctx.progress({ progress: "检查双向路由" });
      const routes = await Promise.all([
        from.call("route", a),
        to.call("route", b),
      ]);
      const result = {
        source: source.name,
        target: target.name,
        routes,
        port,
        started,
        directions: [] as Direction[],
        measureError: undefined as string | undefined,
      };
      if (input.measure) {
        ctx.check();
        ctx.progress({ progress: "服务器直连测速" });
        const token = randomBytes(16).toString("hex");
        try {
          const listenPort = await to.call<number>("listen", {
            ...b,
            bytes,
            token,
          });
          const forward = await from.call<{ direction: Direction }>("measure", {
            ...a,
            port: listenPort,
            bytes,
            token,
          });
          const reverse = await to.call<Direction>("result");
          result.directions = [forward.direction, reverse];
          ctx.progress({ bytes: bytes * 2 });
        } catch (error) {
          result.measureError =
            error instanceof Error ? error.message : String(error);
        }
      }
      ctx.check();
      return { ...result, elapsedMs: Date.now() - started };
    } finally {
      clearInterval(watch);
      clearTimeout(deadline);
      await Promise.all([from.dispose(), to.dispose()]);
    }
  }
}
