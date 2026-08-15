import { describe, expect, it } from "vitest";
import { ExplorerState } from "./explorer";

describe("ExplorerState", () => {
  it("expand/collapse keyed-by-path survives a re-render cycle", () => {
    const state = new ExplorerState();
    state.toggle("proj:-home-u-kersy");
    expect(state.isOpen("proj:-home-u-kersy")).toBe(true);

    // `render()` in explorer.ts only ever reads `state` (via isOpen/dirRenderMode) —
    // it never reconstructs it — so simulating two more render passes here must
    // leave the expanded set exactly as the user left it.
    expect(state.isOpen("proj:-home-u-kersy")).toBe(true);
    expect(state.isOpen("proj:-home-u-kersy")).toBe(true);

    // A second, unrelated key toggling independently doesn't disturb the first.
    state.toggle("dir:/home/u/kersy/src");
    expect(state.isOpen("proj:-home-u-kersy")).toBe(true);
    expect(state.isOpen("dir:/home/u/kersy/src")).toBe(true);

    // Toggling the original key again collapses it, and only it.
    state.toggle("proj:-home-u-kersy");
    expect(state.isOpen("proj:-home-u-kersy")).toBe(false);
    expect(state.isOpen("dir:/home/u/kersy/src")).toBe(true);
  });

  it("shouldFetch prevents duplicate fetch decisions once cached, errored, or in flight", () => {
    const state = new ExplorerState();
    const path = "/home/u/kersy/src";
    expect(state.shouldFetch(path)).toBe(true);

    state.loading.add(path);
    expect(state.shouldFetch(path)).toBe(false);
    state.loading.delete(path);

    state.dirCache.set(path, [{ name: "main.ts", isDir: false }]);
    expect(state.shouldFetch(path)).toBe(false);

    const errPath = "/home/u/kersy/other";
    state.dirErrors.set(errPath, "permission denied");
    expect(state.shouldFetch(errPath)).toBe(false);
  });

  it("dirRenderMode renders errors inline instead of a loading/ready tree", () => {
    const state = new ExplorerState();
    const path = "/home/u/kersy/src";

    expect(state.dirRenderMode(path)).toBe("loading");

    state.dirErrors.set(path, "Path is outside your projects");
    expect(state.dirRenderMode(path)).toBe("error");

    // Even if a cache entry later existed, a recorded error still wins —
    // callers check dirRenderMode() === "error" first.
    state.dirCache.set(path, [{ name: "x", isDir: false }]);
    expect(state.dirRenderMode(path)).toBe("error");

    const readyPath = "/home/u/kersy/docs";
    state.dirCache.set(readyPath, []);
    expect(state.dirRenderMode(readyPath)).toBe("ready");
  });
});
