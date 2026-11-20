import path from "node:path";
import { createHash } from "node:crypto";
import type { Ref } from "../shared/types";
import type { SystemMonitor } from "./monitor";
import { signature, type OperationsStore } from "./operations";

interface Volume {
  path: string;
  source: string;
  filesystem: string;
  total?: number;
  available?: number;
  error?: string;
  serverAddress?: string;
  route?: { src?: string; dev?: string; via?: string };
  trend?: { stamp: number; available: number }[];
}

const sharedVolume = (v: Volume) =>
  v.filesystem === "nfs" || v.filesystem === "nfs4";

function shareKey(
  source: string,
  members: { endpoint: string; signature: string; volume: Volume }[],
) {
  const identity = members
    .map((m) =>
      JSON.stringify([
        m.endpoint,
        m.signature,
        m.volume.path,
        m.volume.filesystem,
        m.volume.serverAddress,
        m.volume.route,
      ]),
    )
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([source, identity]))
    .digest("hex");
}

export function sameConfirmedShare(
  monitor: SystemMonitor,
  operations: OperationsStore,
  from: Ref,
  to: Ref,
) {
  if (from.endpoint === to.endpoint) return false;
  const relative = (mount: string, file: string) => {
    const within = path.posix.relative(mount, file);
    return within !== ".." &&
      !within.startsWith("../") &&
      !path.posix.isAbsolute(within)
      ? within
      : undefined;
  };
  const fleet = monitor.machines();
  for (const group of operations.catalog().groups) {
    if (
      !group.confirmedShares.length ||
      !group.endpoints.includes(from.endpoint) ||
      !group.endpoints.includes(to.endpoint)
    )
      continue;
    const seen = group.endpoints.flatMap((endpoint) => {
      const sample = monitor.recentComparison(endpoint);
      const machine = fleet.find((m) => m.endpoint === endpoint);
      if (!sample || !machine) return [];
      return ((sample.mounts ?? []) as Volume[])
        .filter((v) => sharedVolume(v) && v.route?.src)
        .map((volume) => ({
          endpoint,
          volume,
          signature: signature(machine.config),
        }));
    });
    for (const a of seen.filter((v) => v.endpoint === from.endpoint)) {
      const sourcePath = relative(a.volume.path, from.path);
      if (sourcePath === undefined) continue;
      const members = seen.filter((v) => v.volume.source === a.volume.source);
      const pairMembers = members.filter(
        (v) => v.endpoint === from.endpoint || v.endpoint === to.endpoint,
      );
      if (
        !group.confirmedShares.includes(shareKey(a.volume.source, members)) &&
        !group.confirmedShares.includes(shareKey(a.volume.source, pairMembers))
      )
        continue;
      if (
        members.some(
          (b) =>
            b.endpoint === to.endpoint &&
            relative(b.volume.path, to.path) === sourcePath,
        )
      )
        return true;
    }
  }
  return false;
}

export async function compareMachines(
  monitor: SystemMonitor,
  endpoints: string[],
  confirmedShares: string[] = [],
  trends = false,
  reuseRecent = false,
) {
  if (
    !Array.isArray(endpoints) ||
    endpoints.length < 1 ||
    endpoints.length > 8 ||
    endpoints.some((id) => typeof id !== "string" || !id)
  )
    throw Error("请选择一至八台机器");
  if (
    !Array.isArray(confirmedShares) ||
    confirmedShares.length > 32 ||
    confirmedShares.some((key) => typeof key !== "string" || key.length > 1000)
  )
    throw Error("共享挂载选择无效");
  const fleet = monitor.machines();
  const selected = new Map<string, string>();
  for (const id of endpoints) {
    const machine = fleet.find(
      (m) => m.id === id || m.roots.some((r) => r.endpoint === id),
    );
    if (!machine) throw Error("未知机器：" + id);
    selected.set(machine.id, machine.endpoint);
  }
  const machines = await Promise.all(
    [...selected.values()].map(async (endpoint) => {
      const sample =
        (reuseRecent && monitor.recentComparison(endpoint)) ||
        (await monitor.snapshot({
          endpoint,
          section: "comparison",
        }));
      return {
        endpoint,
        name: sample.name as string,
        stamp: sample.stamp as number | undefined,
        gpuStamp: sample.gpuStamp as number | undefined,
        status: sample.status as "online" | "offline",
        cpuPercent: sample.system?.cpuPercent as number | undefined,
        wslBudget: sample.wslBudget,
        memoryAvailable: sample.system?.memory?.available as number | undefined,
        gpus: ((sample.gpus ?? []) as any[]).map((gpu) => ({
          id: gpu.id as string,
          name: gpu.name as string,
          utilization: gpu.utilization as number | undefined,
          memoryUsed: (gpu.memoryUsed ?? gpu.dedicatedUsed) as
            number | undefined,
          memoryTotal: (gpu.memoryTotal ?? gpu.dedicatedTotal) as
            number | undefined,
        })),
        volumes: ((sample.mounts ?? []) as Volume[]).map(
          ({ trend, ...volume }) => ({
            ...volume,
            ...(trends ? { trend } : {}),
          }),
        ),
        error: (sample.error ?? sample.errors?.[0]) as string | undefined,
      };
    }),
  );
  const bySource = new Map<
    string,
    {
      endpoint: string;
      signature: string;
      name: string;
      stamp?: number;
      volume: Volume;
      online: boolean;
    }[]
  >();
  for (const machine of machines) {
    for (const volume of machine.volumes) {
      if (!sharedVolume(volume)) continue;
      const group = bySource.get(volume.source) ?? [];
      group.push({
        endpoint: machine.endpoint,
        signature: (() => {
          const config = fleet.find(
            (item) => item.endpoint === machine.endpoint,
          )?.config;
          return config ? signature(config) : "";
        })(),
        name: machine.name,
        stamp: machine.stamp,
        volume,
        online: machine.status === "online",
      });
      bySource.set(volume.source, group);
    }
  }
  const shares = [...bySource]
    .filter(([, mount]) => new Set(mount.map((v) => v.endpoint)).size > 1)
    .map(([source, mounts]) => {
      const key = shareKey(source, mounts);
      const confirmed = confirmedShares.includes(key);
      const chosen = mounts
        .filter((m) => m.volume.total != null)
        .sort(
          (a, b) =>
            Number(b.online) - Number(a.online) ||
            (b.stamp ?? 0) - (a.stamp ?? 0),
        )[0];
      return {
        key,
        source,
        confirmed,
        mounts,
        sample: confirmed ? chosen : undefined,
      };
    });
  return { machines, shares };
}
