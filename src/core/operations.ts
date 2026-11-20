import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import type { EndpointConfig } from "../shared/types";

export type PeerAddress = { endpoint: string; address: string };
export type PeerPair = { source: PeerAddress; target: PeerAddress };
type SavedPair = PeerPair & { signatures: [string, string] };
export type PatrolGroup = {
  id: string;
  name: string;
  endpoints: string[];
  confirmedShares: string[];
  mounts: Record<string, string[]>;
};
type Stored = {
  groups: PatrolGroup[];
  pairs: SavedPair[];
  selected?: string;
  pins?: Record<string, string>;
};

export function signature(config: EndpointConfig) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.kind,
        config.host,
        config.sshConfig,
        config.distro,
        config.python,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}
export function privateV4(address: string) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export class OperationsStore {
  private state: Stored = { groups: [], pairs: [] };
  private writes = Promise.resolve();
  constructor(
    private file: string,
    private configs: () => EndpointConfig[],
  ) {}

  async init() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(value.groups) || !Array.isArray(value.pairs))
        throw Error("Invalid operations settings");
      this.state = value;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  private serialize(update: (value: Stored) => Stored) {
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        const next = update(this.state);
        const tmp = this.file + "." + randomUUID() + ".tmp";
        try {
          await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
          await fs.rename(tmp, this.file);
          this.state = next;
        } finally {
          await fs.unlink(tmp).catch(() => {});
        }
      });
    return this.writes;
  }

  private defaultGroup(): PatrolGroup {
    const configs = this.configs();
    const servers = configs.filter((c) => c.kind === "ssh");
    return {
      id: "daily",
      name: "常用巡检",
      endpoints: (servers.length ? servers : configs)
        .slice(0, 3)
        .map((c) => c.id),
      confirmedShares: [],
      mounts: {},
    };
  }

  catalog() {
    const groups = this.state.groups;
    const listed = groups.some((g) => g.id === "daily")
      ? groups
      : [this.defaultGroup(), ...groups];
    return {
      groups: listed,
      selected: this.state.selected ?? "daily",
      pairs: this.state.pairs
        .filter((p) => this.valid(p))
        .map(({ source, target }) => ({ source, target })),
    };
  }

  pinned(endpoint: string) {
    return this.state.pins?.[endpoint];
  }
  async pin(endpoint: string, path: string) {
    await this.serialize((state) => ({
      ...state,
      pins: { ...state.pins, [endpoint]: path },
    }));
  }
  group(id: string) {
    const group = this.catalog().groups.find((item) => item.id === id);
    if (!group) throw Error("巡检组不存在");
    return group;
  }

  async select(id: string) {
    this.group(id);
    await this.serialize((state) => ({ ...state, selected: id }));
    return this.catalog();
  }

  async saveGroup(input: Omit<PatrolGroup, "id"> & { id?: string }) {
    const name = input.name?.trim();
    const known = new Set(this.configs().map((c) => c.id));
    if (
      !name ||
      name.length > 60 ||
      !Array.isArray(input.endpoints) ||
      input.endpoints.length < 1 ||
      input.endpoints.length > 8 ||
      input.endpoints.some((id) => !known.has(id))
    )
      throw Error("请输入巡检组名称并选择一至八台机器");
    const id = input.id ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw Error("巡检组标识无效");
    const endpoints = [...new Set(input.endpoints)];
    const confirmedShares = input.confirmedShares ?? [];
    if (
      !Array.isArray(confirmedShares) ||
      confirmedShares.length > 32 ||
      confirmedShares.some((k) => typeof k !== "string" || k.length > 1500)
    )
      throw Error("共享挂载确认项无效");
    const mounts = Object.fromEntries(
      endpoints.map((endpoint) => {
        const selected = input.mounts?.[endpoint] ?? [];
        if (
          !Array.isArray(selected) ||
          selected.length > 12 ||
          selected.some((p) => typeof p !== "string" || p.length > 1024)
        )
          throw Error("关注路径无效");
        return [endpoint, [...new Set(selected)]];
      }),
    );
    const item: PatrolGroup = {
      id,
      name,
      endpoints,
      confirmedShares: [...new Set(confirmedShares)],
      mounts,
    };
    await this.serialize((state) => {
      const next = state.groups.filter((g) => g.id !== id);
      if (next.length >= 12) throw Error("最多保存 12 个巡检组");
      return { ...state, groups: [...next, item], selected: id };
    });
    return this.catalog();
  }

  private pairConfigs(source: string, target: string) {
    const lookup = this.configs();
    return [
      lookup.find((c) => c.id === source),
      lookup.find((c) => c.id === target),
    ] as const;
  }
  private valid(pair: SavedPair) {
    const [source, target] = this.pairConfigs(
      pair.source.endpoint,
      pair.target.endpoint,
    );
    return (
      source &&
      target &&
      signature(source) === pair.signatures[0] &&
      signature(target) === pair.signatures[1]
    );
  }

  pair(source: string, target: string): PeerPair | undefined {
    const found = this.state.pairs.find(
      (item) =>
        this.valid(item) &&
        ((item.source.endpoint === source && item.target.endpoint === target) ||
          (item.source.endpoint === target && item.target.endpoint === source)),
    );
    if (!found) return;
    return found.source.endpoint === source
      ? found
      : { source: found.target, target: found.source };
  }

  async savePair(pair: PeerPair, remove = false) {
    if (
      !pair?.source ||
      !pair?.target ||
      pair.source.endpoint === pair.target.endpoint ||
      pair.source.address === pair.target.address ||
      !privateV4(pair.source.address) ||
      !privateV4(pair.target.address)
    )
      throw Error("请选择两台机器各自的私网地址");
    const [source, target] = this.pairConfigs(
      pair.source.endpoint,
      pair.target.endpoint,
    );
    if (source?.kind !== "ssh" || target?.kind !== "ssh")
      throw Error("直传需要两台 SSH 机器");
    await this.serialize((state) => {
      const next = state.pairs.filter(
        (p) =>
          !(
            (p.source.endpoint === source.id &&
              p.target.endpoint === target.id) ||
            (p.source.endpoint === target.id && p.target.endpoint === source.id)
          ),
      );
      if (!remove) {
        if (next.length >= 24) throw Error("最多保存 24 条直传关系");
        next.push({
          source: pair.source,
          target: pair.target,
          signatures: [signature(source), signature(target)],
        });
      }
      return { ...state, pairs: next };
    });
    return this.catalog();
  }
}
