import { describe, expect, it } from "vitest";
import { displayAgent, displayProject, ageLabel } from "./names";
import type { AgentView } from "./store";

const rootAgent = (overrides: Partial<AgentView> = {}): AgentView => ({
  id: "sess-123/root",
  sessionId: "sess-123",
  project: "/home/user/kersy",
  tool: "claude-code",
  agentType: "session",
  description: "",
  parentId: null,
  status: "active",
  currentActivity: "",
  contextTokens: 0,
  filesTouched: [],
  verificationRuns: 0,
  lastActivityMs: Date.now(),
  stub: false,
  ...overrides,
});

const subagent = (overrides: Partial<AgentView> = {}): AgentView => ({
  id: "sess-123/agent-abc",
  sessionId: "sess-123",
  project: "/home/user/kersy",
  tool: "claude-code",
  agentType: "general-purpose",
  description: "",
  parentId: "sess-123/root",
  status: "idle",
  currentActivity: "",
  contextTokens: 0,
  filesTouched: [],
  verificationRuns: 0,
  lastActivityMs: Date.now(),
  stub: false,
  ...overrides,
});

describe("displayAgent (root precedence chain)", () => {
  it("uses description when present", () => {
    const agent = rootAgent({ description: "Analyzing code quality" });
    expect(displayAgent(agent)).toBe("Analyzing code quality");
  });

  it("falls back to currentActivity when description is empty", () => {
    const agent = rootAgent({
      description: "",
      currentActivity: "Running tests in /home/user/kersy",
    });
    expect(displayAgent(agent)).toBe("Running tests in /home/user/kersy");
  });

  it("uses Session in <folder> when both description and activity are empty", () => {
    const agent = rootAgent({
      description: "",
      currentActivity: "",
      project: "/home/user/kersy",
    });
    expect(displayAgent(agent, "/home/user/kersy")).toBe("Session in kersy");
  });

  it("prefers projectPath parameter over a.project when provided", () => {
    const agent = rootAgent({
      description: "",
      currentActivity: "",
      project: "/ignored/project",
    });
    expect(displayAgent(agent, "/some/workspace/myproject")).toBe(
      "Session in myproject"
    );
  });

  it("falls back to agent.project when projectPath is not provided", () => {
    const agent = rootAgent({
      description: "",
      currentActivity: "",
      project: "/home/user/kersy",
    });
    expect(displayAgent(agent)).toBe("Session in kersy");
  });

  it("never returns the agent id for root", () => {
    const agent = rootAgent({ description: "Test" });
    const result = displayAgent(agent);
    expect(result).not.toContain(agent.id);
    expect(result).not.toContain("sess-123");
  });

  it("returns trimmed description (whitespace stripped)", () => {
    const agent = rootAgent({ description: "  Analyzing code  " });
    expect(displayAgent(agent)).toBe("Analyzing code");
  });

  it("trims description before checking if empty", () => {
    const agent = rootAgent({
      description: "   ",
      currentActivity: "Running tests",
    });
    expect(displayAgent(agent)).toBe("Running tests");
  });
});

describe("displayAgent (subagent precedence chain)", () => {
  it("uses description when present", () => {
    const agent = subagent({ description: "Verify customer_ref validation" });
    expect(displayAgent(agent)).toBe("Verify customer_ref validation");
  });

  it("falls back to agentType when description is empty", () => {
    const agent = subagent({ description: "", agentType: "general-purpose" });
    expect(displayAgent(agent)).toBe("general-purpose");
  });

  it("never returns the agent id for subagent", () => {
    const agent = subagent({ description: "Task" });
    const result = displayAgent(agent);
    expect(result).not.toContain(agent.id);
    expect(result).not.toContain("sess-123/agent-abc");
  });

  it("returns trimmed description (whitespace stripped)", () => {
    const agent = subagent({
      description: "  Verify validation  ",
    });
    expect(displayAgent(agent)).toBe("Verify validation");
  });

  it("trims description before checking if empty", () => {
    const agent = subagent({
      description: "   ",
      agentType: "code-reviewer",
    });
    expect(displayAgent(agent)).toBe("code-reviewer");
  });
});

describe("displayProject", () => {
  it("extracts last segment from absolute path", () => {
    expect(displayProject("/home/user/kersy")).toBe("kersy");
  });

  it("extracts last segment from nested path", () => {
    expect(displayProject("/usr/local/workspace/project")).toBe("project");
  });

  it("handles slug form with hyphens replacing slashes", () => {
    expect(displayProject("-home-user-kersy")).toBe("kersy");
  });

  it("handles slug form with nested paths", () => {
    expect(displayProject("-usr-local-workspace-project")).toBe("project");
  });

  it("handles single-level paths", () => {
    expect(displayProject("kersy")).toBe("kersy");
  });

  it("handles trailing slashes", () => {
    expect(displayProject("/home/user/kersy/")).toBe("kersy");
  });

  it("resolves slug via projectDirs for hyphenated folder names", () => {
    const projectDirs = [
      { slug: "-home-u-cs-ai-platform", path: "/home/u/cs-ai-platform" },
    ];
    expect(displayProject("-home-u-cs-ai-platform", projectDirs)).toBe(
      "cs-ai-platform"
    );
  });

  it("uses best-effort parsing for ambiguous slug without projectDirs", () => {
    // Without projectDirs, slug "-Users-x-cs-ai-platform" is ambiguous.
    // Best-effort splits and takes last segment, which may be wrong.
    // This test documents the limitation.
    const result = displayProject("-Users-x-cs-ai-platform");
    expect(result).toBeTruthy(); // Assert it returns something, but acknowledge ambiguity
    // Result could be "platform" or "cs-ai-platform" without the real path
  });

  it("falls back to best-effort when slug not found in projectDirs", () => {
    const projectDirs = [
      { slug: "-home-u-other", path: "/home/u/other" },
    ];
    // Slug not in projectDirs, should fall back to best-effort parsing
    const result = displayProject("-home-u-cs-ai-platform", projectDirs);
    expect(result).toBeTruthy();
  });
});

describe("ageLabel", () => {
  it("returns 'unknown' for 0 ms", () => {
    expect(ageLabel(0, 1000)).toBe("unknown");
  });

  it("returns 'just now' for age < 60s", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 30000, now)).toBe("just now");
    expect(ageLabel(now - 59000, now)).toBe("just now");
  });

  it("returns '1 min' at exactly 60s boundary", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 60000, now)).toBe("1 min");
  });

  it("returns 'N min' for age in minutes", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 120000, now)).toBe("2 min");
    expect(ageLabel(now - 300000, now)).toBe("5 min");
    expect(ageLabel(now - 3540000, now)).toBe("59 min");
  });

  it("returns '1 h' at exactly 60 minutes", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 3600000, now)).toBe("1 h");
  });

  it("returns 'N h' for age in hours", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 7200000, now)).toBe("2 h");
    expect(ageLabel(now - 82800000, now)).toBe("23 h");
  });

  it("returns '1 day' at exactly 24 hours", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 86400000, now)).toBe("1 day");
  });

  it("returns 'N days' for age in days", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 172800000, now)).toBe("2 days");
    expect(ageLabel(now - 864000000, now)).toBe("10 days");
  });

  it("handles large day values", () => {
    const now = 1722700000000;
    expect(ageLabel(now - 2592000000, now)).toBe("30 days");
  });
});
