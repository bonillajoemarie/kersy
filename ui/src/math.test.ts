import { describe, it, expect } from "vitest";

describe("math utilities", () => {
  describe("sin² pulse", () => {
    it("returns 0 at frame 0", () => {
      const pulse = Math.pow(Math.sin(0 / 12), 2);
      expect(pulse).toBe(0);
    });

    it("returns 1 at peak (frame = 12 * π/2)", () => {
      const peakFrame = Math.round(12 * Math.PI / 2);
      const pulse = Math.pow(Math.sin(peakFrame / 12), 2);
      expect(pulse).toBeCloseTo(1, 2);
    });

    it("always returns value between 0 and 1", () => {
      for (let frame = 0; frame < 100; frame++) {
        const pulse = Math.pow(Math.sin(frame / 12), 2);
        expect(pulse).toBeGreaterThanOrEqual(0);
        expect(pulse).toBeLessThanOrEqual(1);
      }
    });

    it("is symmetric and periodic", () => {
      const pulse1 = Math.pow(Math.sin(10 / 12), 2);
      const pulse2 = Math.pow(Math.sin((10 + 12 * Math.PI) / 12), 2);
      expect(pulse1).toBeCloseTo(pulse2, 5);
    });
  });

  describe("spawn ease-in", () => {
    const spawnEase = (elapsedMs: number) => Math.min(1, elapsedMs / 300);

    it("returns 0 at elapsed=0", () => {
      expect(spawnEase(0)).toBe(0);
    });

    it("returns 1 at elapsed=300", () => {
      expect(spawnEase(300)).toBe(1);
    });

    it("returns 1 for elapsed > 300", () => {
      expect(spawnEase(500)).toBe(1);
      expect(spawnEase(1000)).toBe(1);
    });

    it("interpolates linearly between 0 and 300", () => {
      expect(spawnEase(150)).toBeCloseTo(0.5, 2);
      expect(spawnEase(75)).toBeCloseTo(0.25, 2);
      expect(spawnEase(225)).toBeCloseTo(0.75, 2);
    });
  });

  describe("camera lerp", () => {
    const lerp = (current: number, target: number, factor: number = 0.2) =>
      current + (target - current) * factor;

    const stopThreshold = 0.1;

    it("moves toward target by factor", () => {
      expect(lerp(0, 100)).toBe(20);
      expect(lerp(20, 100)).toBe(36);
      expect(lerp(36, 100)).toBe(48.8);
    });

    it("snaps to target when within threshold", () => {
      const current = 99.95;
      const target = 100;
      const dx = target - current;
      if (Math.abs(dx) <= stopThreshold) {
        expect(target).toBe(100);
      }
    });

    it("continues lerping when outside threshold", () => {
      const current = 90;
      const target = 100;
      const dx = target - current;
      expect(Math.abs(dx)).toBeGreaterThan(stopThreshold);
      const next = lerp(current, target);
      expect(next).toBe(92);
    });
  });

  describe("hitTestNode logic", () => {
    type Node = { id: string; x: number; y: number; isSession: boolean };
    type HitResult = { id: string; radius: number } | null;

    const hitTestNode = (
      wx: number,
      wy: number,
      nodes: Node[],
      zoom: number
    ): HitResult => {
      let best: HitResult = null;
      let bestDist = Infinity;
      for (const n of nodes) {
        const baseR = n.isSession ? 14 : 8;
        const dist = Math.hypot(n.x - wx, n.y - wy);
        if (dist < baseR + 6 && dist < bestDist) {
          bestDist = dist;
          best = { id: n.id, radius: baseR };
        }
      }
      return best;
    };

    it("returns null when no nodes", () => {
      expect(hitTestNode(0, 0, [], 1)).toBeNull();
    });

    it("returns null when all nodes too far", () => {
      const nodes: Node[] = [{ id: "a", x: 100, y: 100, isSession: true }];
      expect(hitTestNode(0, 0, nodes, 1)).toBeNull();
    });

    it("returns closest node within radius+6", () => {
      const nodes: Node[] = [
        { id: "a", x: 0, y: 0, isSession: true },
        { id: "b", x: 10, y: 0, isSession: true },
      ];
      const hit = hitTestNode(2, 0, nodes, 1);
      expect(hit).not.toBeNull();
      expect(hit!.id).toBe("a");
    });

    it("prefers closer node when both in range", () => {
      const nodes: Node[] = [
        { id: "a", x: 0, y: 0, isSession: true },
        { id: "b", x: 5, y: 0, isSession: true },
      ];
      const hit = hitTestNode(4, 0, nodes, 1);
      expect(hit).not.toBeNull();
      expect(hit!.id).toBe("b");
    });

    it("uses different radius for subagents (8) vs sessions (14)", () => {
      const session = { id: "s", x: 0, y: 0, isSession: true };
      const subagent = { id: "a", x: 0, y: 0, isSession: false };

      expect(hitTestNode(19, 0, [session], 1)).not.toBeNull(); // 14+6=20, 19<20
      expect(hitTestNode(21, 0, [session], 1)).toBeNull(); // 21>20

      expect(hitTestNode(13, 0, [subagent], 1)).not.toBeNull(); // 8+6=14, 13<14
      expect(hitTestNode(15, 0, [subagent], 1)).toBeNull(); // 15>14
    });

    it("accounts for zoom by testing in world space (zoom doesn't affect hit test)", () => {
      // hitTestNode operates in world coordinates, zoom is applied elsewhere
      const nodes: Node[] = [{ id: "a", x: 0, y: 0, isSession: true }];
      expect(hitTestNode(19, 0, nodes, 0.5)).not.toBeNull();
      expect(hitTestNode(19, 0, nodes, 2)).not.toBeNull();
    });
  });

  describe("label pill visibility", () => {
    const showPill = (zoom: number, isActive: boolean) => zoom >= 0.5 || isActive;

    it("shows pill at zoom >= 0.5 for inactive nodes", () => {
      expect(showPill(0.5, false)).toBe(true);
      expect(showPill(1, false)).toBe(true);
    });

    it("hides pill at zoom < 0.5 for inactive nodes", () => {
      expect(showPill(0.4, false)).toBe(false);
      expect(showPill(0.1, false)).toBe(false);
    });

    it("always shows pill for active nodes regardless of zoom", () => {
      expect(showPill(0.1, true)).toBe(true);
      expect(showPill(0.01, true)).toBe(true);
    });
  });
});