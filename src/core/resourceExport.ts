const columns = [
  "stamp",
  "machine",
  "section",
  "systemCpuPercent",
  "systemMemoryUsedBytes",
  "systemMemoryTotalBytes",
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
