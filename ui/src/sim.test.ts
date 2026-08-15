import { describe, expect, it } from "vitest";
import { Sim } from "./sim";

describe("Sim", () => {
  it("adds nodes on sync, keeps positions of survivors, drops removed", () => {
    const s = new Sim(() => {});
    s.sync(["a", "b"], [{ from: "a", to: "b" }]);
    expect(s.positions().size).toBe(2);
    const before = s.positions().get("a")!;
    s.sync(["a"], []);
    expect(s.positions().size).toBe(1);
    expect(s.positions().get("a")).toEqual(before); // survivor keeps its position
  });

  it("reheats on change and settles when ticked out", () => {
    const s = new Sim(() => {});
    s.sync(["a"], []);
    expect(s.settled()).toBe(false);   // fresh sync = reheated
    for (let i = 0; i < 500; i++) s.tickOnce();
    expect(s.settled()).toBe(true);    // alpha decayed below min
  });

  it("reheats on edge-only changes (same node set, new edge)", () => {
    const s = new Sim(() => {});
    s.sync(["a", "b"], []);
    for (let i = 0; i < 500; i++) s.tickOnce();
    expect(s.settled()).toBe(true);
    s.sync(["a", "b"], [{ from: "a", to: "b" }]);
    expect(s.settled()).toBe(false);
  });

  it("spreads spawn positions by index instead of coincident placement", () => {
    const s = new Sim(() => {});
    s.sync(["a", "b", "c"], []);
    const pos = s.positions();
    const a = pos.get("a")!;
    const b = pos.get("b")!;
    const c = pos.get("c")!;
    const allEqual = a.x === b.x && a.y === b.y && b.x === c.x && b.y === c.y;
    expect(allEqual).toBe(false);
  });
});
