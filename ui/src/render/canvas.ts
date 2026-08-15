import type { Camera, DrawEdge, DrawNode, Renderer } from "./renderer";

export class CanvasRenderer implements Renderer {
  constructor(private ctx: CanvasRenderingContext2D) {}
  resize(w: number, h: number): void { this.ctx.canvas.width = w; this.ctx.canvas.height = h; }
  draw(nodes: DrawNode[], edges: DrawEdge[], cam: Camera): void {
    const { ctx } = this;
    const { width: w, height: h } = ctx.canvas;
    ctx.fillStyle = "#2B2B2B"; ctx.fillRect(0, 0, w, h);
    const sx = (x: number) => (x - cam.x) * cam.zoom + w / 2;
    const sy = (y: number) => (y - cam.y) * cam.zoom + h / 2;
    ctx.strokeStyle = "#323232";
    for (const e of edges) { ctx.beginPath(); ctx.moveTo(sx(e.x1), sy(e.y1)); ctx.lineTo(sx(e.x2), sy(e.y2)); ctx.stroke(); }
    for (const n of nodes) {
      const r = n.radius * (1 + 0.25 * n.pulse) * cam.zoom;
      ctx.fillStyle = `rgb(${n.color.map((c) => Math.round(c * 255)).join(",")})`;
      ctx.beginPath(); ctx.arc(sx(n.x), sy(n.y), r, 0, Math.PI * 2); ctx.fill();
    }
  }
}
