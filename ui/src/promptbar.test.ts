import { describe, expect, it } from "vitest";
import { disabledReason } from "./promptbar";

describe("disabledReason", () => {
  it("no CLI beats no projects beats an empty prompt", () => {
    // noCli wins even when projects exist and a prompt is typed
    expect(disabledReason(false, 3, "do the thing")).toBe("Claude Code CLI not found on PATH");
    // noCli wins even when projects are also missing
    expect(disabledReason(false, 0, "")).toBe("Claude Code CLI not found on PATH");
  });

  it("no projects beats an empty prompt once the CLI is available", () => {
    expect(disabledReason(true, 0, "do the thing")).toBe("No projects found — open a project with Claude Code first");
    expect(disabledReason(null, 0, "do the thing")).toBe("No projects found — open a project with Claude Code first");
  });

  it("empty (or whitespace-only) prompt is the last reason checked", () => {
    expect(disabledReason(true, 2, "")).toBe("Enter a prompt to run");
    expect(disabledReason(true, 2, "   ")).toBe("Enter a prompt to run");
  });

  it("returns null once CLI is available, a project exists, and a prompt is entered", () => {
    expect(disabledReason(true, 1, "do the thing")).toBeNull();
  });

  it("treats an unresolved cli_available probe (null) as not-yet-disabled for that reason", () => {
    expect(disabledReason(null, 1, "do the thing")).toBeNull();
  });
});
