import { GlRenderer } from "./gl";
import { CanvasRenderer } from "./canvas";

export interface DrawNode { x: number; y: number; radius: number; color: [number, number, number]; pulse: number; }
export interface DrawEdge { x1: number; y1: number; x2: number; y2: number; }
export interface Camera { x: number; y: number; zoom: number; }
export interface Renderer { draw(nodes: DrawNode[], edges: DrawEdge[], cam: Camera): void; resize(w: number, h: number): void; }

const hex = (h: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

export const STATUS_COLORS: Record<string, [number, number, number]> = {
  active: hex("#CC7832"), idle: hex("#6897BB"), stale: hex("#808080"),
  success: hex("#6A8759"), error: hex("#BC3F3C"),
};

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl2", { antialias: true });
  return gl ? new GlRenderer(gl) : new CanvasRenderer(canvas.getContext("2d")!);
}
