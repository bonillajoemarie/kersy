import { GlRenderer } from "./gl";
import { CanvasRenderer } from "./canvas";

export interface DrawNode { x: number; y: number; radius: number; color: [number, number, number]; pulse: number; }
export interface DrawEdge { x1: number; y1: number; x2: number; y2: number; }
export interface Camera { x: number; y: number; zoom: number; }
export interface Renderer { draw(nodes: DrawNode[], edges: DrawEdge[], cam: Camera): void; resize(w: number, h: number): void; }

const hex = (h: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

export const STATUS_COLORS: Record<string, [number, number, number]> = {
  active: hex("#d95926"), idle: hex("#3987e5"), stale: hex("#8a8a86"),
  success: hex("#0ca30c"), error: hex("#d03b3b"),
};

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl2", { antialias: true });
  if (gl) return new GlRenderer(gl);
  const ctx2d = canvas.getContext("2d");
  if (ctx2d) return new CanvasRenderer(ctx2d);
  throw new Error("Kersy: no rendering context available (webgl2 and 2d both failed)");
}
