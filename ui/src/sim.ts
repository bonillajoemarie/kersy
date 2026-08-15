import { forceCenter, forceLink, forceManyBody, forceSimulation, type Simulation } from "d3-force";

export interface SimNode { id: string; x: number; y: number; vx?: number; vy?: number; }
interface SimLink { source: string; target: string; }

export class Sim {
  private nodes: SimNode[] = [];
  private sim: Simulation<SimNode, SimLink>;
  private edgeKey = "";

  constructor(onTick: () => void) {
    // onTick is unused under the no-restart() design: main.ts drives frames itself
    // via its own requestAnimationFrame loop and calls tickOnce()/draw() directly.
    this.sim = forceSimulation<SimNode>([])
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(0, 0))
      .force("link", forceLink<SimNode, SimLink>([]).id((d) => d.id).distance(60))
      .on("tick", onTick)
      .stop();   // main.ts drives frames via requestAnimationFrame; tests via tickOnce()
  }

  sync(ids: string[], edges: Array<{ from: string; to: string }>): void {
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const nodesChanged = ids.length !== this.nodes.length || ids.some((id) => !byId.has(id));
    const edgeKey = edges
      .map((e) => `${e.from}>${e.to}`)
      .sort()
      .join("|");
    const changed = nodesChanged || edgeKey !== this.edgeKey;
    this.edgeKey = edgeKey;
    this.nodes = ids.map((id, i) => byId.get(id) ?? { id, x: Math.cos(i) * 50, y: Math.sin(i) * 50 });
    this.sim.nodes(this.nodes);
    (this.sim.force("link") as ReturnType<typeof forceLink>)!
      .links(edges.map((e) => ({ source: e.from, target: e.to })));
    // Reheat by raising alpha only — we never call restart(), which would start d3's
    // internal timer (requires a DOM-ish environment and conflicts with our own
    // requestAnimationFrame-driven tick loop in main.ts). alpha() alone is sufficient:
    // settled() just compares alpha to alphaMin, and main.ts drives ticks itself via
    // `if (!sim.settled()) { sim.tickOnce(); draw(); }` — the 0%-idle rule.
    if (changed) this.sim.alpha(1);
  }

  positions(): Map<string, { x: number; y: number }> {
    return new Map(this.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  }

  settled(): boolean { return this.sim.alpha() < this.sim.alphaMin(); }
  tickOnce(): void { this.sim.tick(); }
  stop(): void { this.sim.stop(); }
}
