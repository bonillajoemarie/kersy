import { describe, expect, it } from "vitest";
import { Store, type MapEventMsg } from "./store";

const agent = (id: string, parentId: string | null = null): MapEventMsg => ({
  event: "agentUpserted",
  data: { id, sessionId: id.split("/")[0], project: "-p", tool: "claude-code", agentType: "session", description: "",
    parentId, status: "active", currentActivity: "Bash: ls", contextTokens: 0,
    filesTouched: [], verificationRuns: 0, lastActivityMs: 1, stub: false },
});

describe("Store", () => {
  it("upserts, removes, and links edges by parentId", () => {
    const s = new Store();
    s.apply(agent("sess-1"));
    s.apply(agent("sess-1/a1", "sess-1"));
    expect(s.nodes().length).toBe(2);
    expect(s.edges()).toContainEqual({ from: "sess-1", to: "sess-1/a1" });
    s.apply({ event: "agentRemoved", data: { id: "sess-1/a1" } });
    expect(s.nodes().length).toBe(1);
  });

  it("stores task boards per session and fires onchange", () => {
    const s = new Store();
    let fired = 0;
    s.onchange = () => fired++;
    s.apply({ event: "tasksUpserted", data: { sessionId: "sess-1",
      tasks: [{ id: "1", subject: "x", status: "in_progress", blockedBy: [] }] } });
    expect(s.tasks.get("sess-1")![0].status).toBe("in_progress");
    expect(fired).toBe(1);
  });

  it("keeps discovery summary", () => {
    const s = new Store();
    s.apply({ event: "discoveryDone", data: { roots: ["/h/.claude"], projects: 3, sessions: 12 } });
    expect(s.discovery!.sessions).toBe(12);
  });
});
