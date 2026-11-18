const columns = [
  "stamp",
  "machine",
  "section",
  "systemCpuPercent",
  "systemMemoryUsedBytes",
  "systemMemoryTotalBytes",
  "systemMemoryAvailableBytes",
  "systemCommitUsedBytes",
  "systemCommitLimitBytes",
  "systemPagefileBytes",
  "swapUsedBytes",
  "swapTotalBytes",
  "memoryPsiSomeAvg10",
  "swapInPagesPerSecond",
  "swapOutPagesPerSecond",
  "kernelOomKillsSinceBoot",
  "backingVolumeAvailableBytes",
  "pid",
  "name",
  "cpuOneCorePercent",
  "rssBytes",
  "pssBytes",
  "privateBytes",
  "gpu",
  "gpuUtilizationPercent",
  "gpuSharedMemoryBytes",
  "gpuMemoryUsedBytes",
  "gpuMemoryTotalBytes",
  "temperatureC",
  "powerWatts",
  "device",
  "path",
  "readBytesPerSecond",
  "writeBytesPerSecond",
  "receiveBytesPerSecond",
  "sendBytesPerSecond",
  "diskTotalBytes",
  "diskAvailableBytes",
  "memorySource",
  "memoryStamp",
];
export const csvHeader = columns.join(",") + "\r\n";
function cell(v: any) {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && /^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function csvRows(s: any) {
  const common = {
    stamp: s.stamp,
    machine: s.name ?? s.machine,
    section: s.section,
  };
  const rows: any[] = [
    {
      ...common,
      name: "system",
      systemCpuPercent: s.system?.cpuPercent,
      systemMemoryUsedBytes: s.system?.memory?.used,
      systemMemoryTotalBytes: s.system?.memory?.total,
      systemMemoryAvailableBytes: s.system?.memory?.available,
      systemCommitUsedBytes: s.system?.memory?.commitUsed,
      systemCommitLimitBytes: s.system?.memory?.commitLimit,
      systemPagefileBytes: s.system?.memory?.pagefileBytes,
      swapUsedBytes: s.system?.memory?.swapUsed,
      swapTotalBytes: s.system?.memory?.swapTotal,
      memoryPsiSomeAvg10: s.system?.pressure?.memory?.some?.avg10,
      swapInPagesPerSecond: s.system?.pressure?.paging?.swapInPagesPerSecond,
      swapOutPagesPerSecond: s.system?.pressure?.paging?.swapOutPagesPerSecond,
      kernelOomKillsSinceBoot: s.system?.pressure?.paging?.oomKills,
      backingVolumeAvailableBytes: s.physicalBudget?.available,
    },
  ];
  for (const p of s.section === "process" && s.detail
    ? [s.detail]
    : (s.processes ?? []))
    rows.push({
      ...common,
      pid: p.pid,
      name: p.name,
      cpuOneCorePercent: p.cpuPercent,
      rssBytes: p.rss,
      pssBytes: p.pss,
      privateBytes: p.privateBytes,
      memorySource: p.memorySource,
      memoryStamp: p.memoryStamp,
      gpuMemoryUsedBytes: p.gpuMemory,
      gpuSharedMemoryBytes: p.gpuSharedMemory,
    });
  for (const g of s.gpus ?? [])
    rows.push({
      ...common,
      gpu: g.id,
      name: g.name,
      gpuUtilizationPercent: g.utilization,
      gpuMemoryUsedBytes: g.memoryUsed,
      gpuMemoryTotalBytes: g.memoryTotal,
      temperatureC: g.temperature,
      powerWatts: g.powerWatts,
    });
  for (const d of s.io?.disks ?? [])
    rows.push({
      ...common,
      device: d.name,
      readBytesPerSecond: d.readBytesPerSecond,
      writeBytesPerSecond: d.writeBytesPerSecond,
    });
  for (const n of s.io?.network ?? [])
    rows.push({
      ...common,
      device: n.name,
      receiveBytesPerSecond: n.receiveBytesPerSecond,
      sendBytesPerSecond: n.sendBytesPerSecond,
    });
  for (const v of s.io?.volumes ?? [])
    rows.push({
      ...common,
      path: v.path,
      diskTotalBytes: v.total,
      diskAvailableBytes: v.available,
    });
  return rows
    .map((r) => columns.map((k) => cell(r[k])).join(",") + "\r\n")
    .join("");
}

/** Project only the requested resource section; keep the cached snapshot immutable. */
export function compactResourceSnapshot(value: any): any {
  if (value.machines)
    return {
      machines: value.machines,
      snapshots: (value.snapshots ?? []).map((snapshot: any) =>
        compactResourceSnapshot({ ...snapshot, section: "summary" }),
      ),
    };
  const common = Object.fromEntries(
    ["stamp", "endpoint", "machine", "name", "section", "status", "errors"]
      .filter((k) => value[k] !== undefined)
      .map((k) => [k, value[k]]),
  );
  const sections: Record<string, string[]> = {
    summary: ["system", "physicalBudget"],
    processes: ["processes", "total", "offset", "limit"],
    process: ["detail", "detailStatus", "detailError"],
    gpus: ["gpus"],
    gpu: ["detail", "processes"],
    io: ["io"],
  };
  for (const k of sections[value.section ?? "summary"] ?? [])
    if (value[k] !== undefined) common[k] = value[k];
  return common;
}
