export type LayoutItem = {
  id: string;
  parent?: string;
  width?: number;
  height?: number;
};
// A subtree occupies at least its parent's height. Children are ordered by
// their directory listing and centred as a group beside the parent.
export function surfaceLayout(items: LayoutItem[]) {
  const children = new Map<string | undefined, LayoutItem[]>(),
    widths: number[] = [],
    span = new Map<string, number>();
  for (const item of items) {
    const list = children.get(item.parent) ?? [];
    list.push(item);
    children.set(item.parent, list);
  }
  const gap = 16;
  function measure(n: LayoutItem, depth: number): number {
    widths[depth] = Math.max(widths[depth] ?? 0, n.width ?? 258);
    const kids = children.get(n.id) ?? [];
    const size = Math.max(
      n.height ?? 50,
      kids.reduce((sum, k) => sum + measure(k, depth + 1) + gap, -gap),
    );
    span.set(n.id, size);
    return size;
  }
  const roots = children.get(undefined) ?? [];
  roots.forEach((r) => measure(r, 0));
  const columns = [0];
  for (const w of widths) columns.push(columns.at(-1)! + w + 52);
  const result: { id: string; x: number; y: number }[] = [];
  function place(n: LayoutItem, level: number, top: number) {
    const size = span.get(n.id)!;
    result.push({
      id: n.id,
      x: columns[level],
      y: top + (size - (n.height ?? 50)) / 2,
    });
    const kids = children.get(n.id) ?? [];
    let y =
      top +
      (size - kids.reduce((sum, k) => sum + span.get(k.id)! + gap, -gap)) / 2;
    for (const k of kids) {
      place(k, level + 1, y);
      y += span.get(k.id)! + gap;
    }
  }
  let y = 0;
  for (const n of roots) {
    place(n, 0, y);
    y += span.get(n.id)! + gap;
  }
  return result;
}
