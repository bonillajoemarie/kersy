import { describe, expect, it } from "vitest";
import { statusOf } from "./status";
import type { AgentView } from "./store";

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: "s1", sessionId: "s1", project: "-p", tool: "claude-code", agentType: "session",
    description: "", parentId: null, status: "active", currentActivity: "", contextTokens: 0,
    filesTouched: [], verificationRuns: 0, lastActivityMs: 0, stub: false,
    ...overrides,
  };
}

describe("statusOf", () => {
  it("derives active/idle/stale from wall-clock age of lastActivityMs, not the frozen status field", () => {
    const now = 1_000_000_000;
    const a = agent({ status: "active", lastActivityMs: now - 5_000 });
    expect(statusOf(a, now)).toBe("active");

    const b = agent({ status: "active", lastActivityMs: now - 60_000 }); // event froze "active" long ago
    expect(statusOf(b, now)).toBe("idle");

    const c = agent({ status: "active", lastActivityMs: now - 700_000 }); // still frozen "active"
    expect(statusOf(c, now)).toBe("stale");
  });

  it("stubs are always stale regardless of lastActivityMs", () => {
    const now = 1_000_000_000;
    const s = agent({ stub: true, lastActivityMs: now });
    expect(statusOf(s, now)).toBe("stale");
  });

  it("falls back to the raw status field when lastActivityMs is unset (0)", () => {
    const a = agent({ status: "idle", lastActivityMs: 0 });
    expect(statusOf(a, Date.now())).toBe("idle");
  });
});
