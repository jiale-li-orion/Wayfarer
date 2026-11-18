export function pressureSignals(sample: any): string[] {
  const memory = sample?.system?.memory,
    psi = sample?.system?.pressure?.memory;
  const warnings: string[] = [];
  if (
    memory?.total > 0 &&
    memory.available != null &&
    memory.available / memory.total < 0.1
  )
    warnings.push("可用物理内存低于 10%");
  if (memory?.commitLimit > 0 && memory.commitUsed / memory.commitLimit >= 0.85)
    warnings.push("Windows 提交量达到上限的 85%");
  if (psi?.some?.avg10 >= 10) warnings.push("近 10 秒内存等待达到 10%");
  const disks = sample?.physicalBudget
    ? [sample.physicalBudget]
    : (sample?.system?.storage?.volumes ?? []);
  for (const disk of disks)
    if (disk.total > 0 && disk.available / disk.total < 0.05)
      warnings.push(`${disk.mount ?? disk.path} 卷余量低于 5%`);
  return warnings;
}
