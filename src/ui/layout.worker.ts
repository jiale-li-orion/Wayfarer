import { stratify, tree } from "d3-hierarchy";
export type LayoutItem = { id: string; parent?: string };
self.onmessage = (event: MessageEvent<{ id: number; items: LayoutItem[] }>) => {
  const start = performance.now();
  const { id, items } = event.data;
  try {
    const root = stratify<LayoutItem>()
      .id((d) => d.id)
      .parentId((d) => d.parent)([
      { id: "__root__" },
      ...items.map((d) => ({ ...d, parent: d.parent ?? "__root__" })),
    ]);
    const positions = tree<LayoutItem>()
      .nodeSize([66, 310])(root)
      .descendants()
      .filter((d) => d.id !== "__root__")
      .map((d) => ({ id: d.id, x: d.y - 310, y: d.x }));
    self.postMessage({
      id,
      positions,
      ms: performance.now() - start,
      nodes: items.length,
    });
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};
