import type { SystemMonitor } from "./monitor";

interface Volume {
  path: string;
  source: string;
  filesystem: string;
  total?: number;
  available?: number;
  error?: string;
}

export async function compareMachines(
  monitor: SystemMonitor,
  endpoints: string[],
  confirmedShares: string[] = [],
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
      const sample = await monitor.snapshot({
        endpoint,
        section: "comparison",
      });
      return {
        endpoint,
        name: sample.name as string,
        stamp: sample.stamp as number | undefined,
        gpuStamp: sample.gpuStamp as number | undefined,
        status: sample.status as "online" | "offline",
        cpuPercent: sample.system?.cpuPercent as number | undefined,
        memoryAvailable: sample.system?.memory?.available as number | undefined,
        gpus: ((sample.gpus ?? []) as any[]).map((gpu) => ({
          id: gpu.id as string,
          name: gpu.name as string,
          utilization: gpu.utilization as number | undefined,
          memoryUsed: (gpu.memoryUsed ?? gpu.dedicatedUsed) as
            | number
            | undefined,
          memoryTotal: (gpu.memoryTotal ?? gpu.dedicatedTotal) as
            | number
            | undefined,
        })),
        volumes: (sample.mounts ?? []) as Volume[],
        error: (sample.error ?? sample.errors?.[0]) as string | undefined,
      };
    }),
  );
  const bySource = new Map<
    string,
    {
      endpoint: string;
      name: string;
      stamp?: number;
      volume: Volume;
      online: boolean;
    }[]
  >();
  for (const machine of machines) {
    for (const volume of machine.volumes) {
      if (!["nfs", "nfs4"].includes(volume.filesystem)) continue;
      const group = bySource.get(volume.source) ?? [];
      group.push({
        endpoint: machine.endpoint,
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
      const key = JSON.stringify([
        source,
        mounts.map((m) => [m.endpoint, m.volume.path].join(":")).sort(),
      ]);
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
