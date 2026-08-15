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
});
