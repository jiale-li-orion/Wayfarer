import { memo, useEffect, useRef } from "react";
import { useStore, type Node, type Edge } from "@xyflow/react";
/** At overview zoom, one drawing surface replaces thousands of tiny DOM nodes. */
export const OverviewCanvas = memo(function OverviewCanvas({
  nodes,
  edges,
}: {
  nodes: Node[];
  edges: Edge[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const transform = useStore((s) => s.transform);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const rect = element.parentElement!.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio, 1.5);
      const width = Math.round(rect.width * ratio),
        height = Math.round(rect.height * ratio);
      if (element.width !== width) element.width = width;
      if (element.height !== height) element.height = height;
      const ctx = element.getContext("2d")!;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const style = getComputedStyle(document.body);
      const muted =
        style.getPropertyValue("--vscode-descriptionForeground").trim() ||
        "#91989f";
      const foreground =
        style.getPropertyValue("--vscode-foreground").trim() || "#dddddd";
      const accent =
        style.getPropertyValue("--vscode-focusBorder").trim() || "#3899e8";
      const [x, y, z] = transform;
      ctx.translate(x, y);
      ctx.scale(z, z);
      const map = new Map(nodes.map((n) => [n.id, n]));
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 0.7 / z;
      ctx.beginPath();
      for (const edge of edges) {
        const a = map.get(edge.source),
          b = map.get(edge.target);
        if (!a || !b) continue;
        const sx = a.position.x + 258,
          sy = a.position.y + 25,
          tx = b.position.x,
          ty = b.position.y + 25;
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo((sx + tx) / 2, sy, (sx + tx) / 2, ty, tx, ty);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const n of nodes) {
        const px = n.position.x,
          py = n.position.y;
        if (
          (px + 258) * z + x < 0 ||
          px * z + x > rect.width ||
          (py + 50) * z + y < 0 ||
          py * z + y > rect.height
        )
          continue;
        ctx.fillStyle = n.selected ? accent : muted;
        ctx.fillRect(px, py, 258, 50);
        if (n.data.kind === "endpoint") {
          ctx.fillStyle = foreground;
          ctx.font = 12 / z + "px " + style.fontFamily;
          ctx.textAlign = "right";
          ctx.fillText(String(n.data.label), px - 8 / z, py + 25 + 4 / z);
        }
      }
    };
    const frame = requestAnimationFrame(draw);
    const observer = new ResizeObserver(draw);
    observer.observe(element.parentElement!);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [nodes, edges, transform]);
  return <canvas ref={canvas} className="overview-layer" aria-hidden="true" />;
});
