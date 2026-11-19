import { randomBytes } from "node:crypto";
import { RemoteEndpoint } from "../adapters/remote";
import { TransportLost } from "./lifecycle";
import type { EndpointConfig, Entry } from "../shared/types";
import type { JobContext } from "./jobs";
import type { PeerPair } from "./operations";

type Progress = {
  offset: number;
  complete: boolean;
  done: boolean;
  error?: string;
  readMs: number;
  writeMs: number;
  syncMs: number;
  cpuMs: number;
};
const brief = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 280);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PeerTransfer {
  private channels = new Set<RemoteEndpoint>();
  constructor(private helper: string) {}

  stats() {
    return { channels: this.channels.size };
  }

  private open(config: EndpointConfig) {
    const channel = new RemoteEndpoint(config, this.helper);
    this.channels.add(channel);
    return channel;
  }
  private async close(channel: RemoteEndpoint) {
    try {
      await channel.dispose();
    } finally {
      this.channels.delete(channel);
    }
  }
  abort() {
    for (const channel of this.channels) channel.abort();
  }

  private async call<T>(
    channel: RemoteEndpoint,
    method: string,
    args: Record<string, unknown>,
    limit = 15000,
  ) {
    const timer = setTimeout(() => channel.abort(), limit);
    try {
      return await channel.call<T>(method, args);
    } finally {
      clearTimeout(timer);
    }
  }

  async fence(target: EndpointConfig, partial: Entry) {
    const channel = this.open(target);
    try {
      await this.call(channel, "fence", {
        path: partial.path,
        identity: partial.identity,
      });
    } catch (error: any) {
      if (error.type === "BlockingIOError")
        throw new TransportLost(error.message);
      throw error;
    } finally {
      await this.close(channel);
    }
  }

  async send(
    ctx: JobContext,
    pair: PeerPair,
    source: EndpointConfig,
    target: EndpointConfig,
    entry: Entry,
    partial: Entry,
    offset: number,
    onProgress: (offset: number) => Promise<void>,
  ) {
    const reader = this.open(source);
    const writer = this.open(target);
    const count = entry.size;
    const shared = {
      token: randomBytes(32).toString("hex"),
      size: count,
      offset,
    };
    let sent = false;
    let a: Progress | undefined;
    let b: Progress | undefined;
    let operationalError: unknown;
    try {
      const listener = await this.call<{ port: number; fingerprint: string }>(
        writer,
        "listen",
        {
          ...shared,
          path: partial.path,
          identity: partial.identity,
          local: pair.target.address,
          peer: pair.source.address,
        },
      );
      ctx.check();
      sent = true;
      await this.call(reader, "send", {
        ...shared,
        ...listener,
        path: entry.path,
        source: entry,
        local: pair.source.address,
        peer: pair.target.address,
      });
      do {
        ctx.check();
        [a, b] = await Promise.all([
          this.call<Progress>(reader, "status", {}, 4000),
          this.call<Progress>(writer, "status", {}, 4000),
        ]);
        if (b.offset > offset && b.offset <= count) await onProgress(b.offset);
        if (a.error || b.error || (a.done && b.done)) break;
        await sleep(200);
      } while (true);
    } catch (error) {
      operationalError = error;
    } finally {
      // A confirmed stop releases the writer's file lock before the relay can write.
      const settled = await Promise.allSettled([
        a?.done ? a : this.call<Progress | null>(reader, "stop", {}, 4500),
        b?.done ? b : this.call<Progress | null>(writer, "stop", {}, 4500),
      ]);
      if (settled[0].status === "fulfilled") a = settled[0].value ?? undefined;
      if (settled[1].status === "fulfilled") b = settled[1].value ?? undefined;
      await Promise.all([this.close(reader), this.close(writer)]);
    }
    if (b?.offset !== undefined && b.offset > offset && b.offset <= count)
      await onProgress(b.offset);
    ctx.check();
    if (sent && !b?.done)
      throw new TransportLost("直传写入尚待确认，恢复时先检查暂存");
    const cause = operationalError
      ? brief(operationalError)
      : (b?.error ?? a?.error);
    return {
      completed: !!b?.complete && b.offset === count && !!a?.complete,
      reason: cause,
      bytes: Math.max(0, (b?.offset ?? offset) - offset),
      readMs: a?.readMs ?? 0,
      writeMs: b?.writeMs ?? 0,
      syncMs: b?.syncMs ?? 0,
      cpuMs: (a?.cpuMs ?? 0) + (b?.cpuMs ?? 0),
    };
  }
}
