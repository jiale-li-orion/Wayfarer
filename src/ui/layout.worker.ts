import { surfaceLayout, type LayoutItem } from "../shared/surfaceLayout";
self.onmessage = (e: MessageEvent<{ id: number; items: LayoutItem[] }>) => {
  const { id, items } = e.data,
    start = performance.now();
  try {
    const positions = surfaceLayout(items);
    self.postMessage({
      id,
      positions,
      ms: performance.now() - start,
      nodes: items.length,
    });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
