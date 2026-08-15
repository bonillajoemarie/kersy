export interface AgentView { id: string; sessionId: string; project: string; tool: string; agentType: string;
  description: string; parentId: string | null; status: "active" | "idle" | "stale";
  currentActivity: string; contextTokens: number; filesTouched: string[];
  verificationRuns: number; lastActivityMs: number; stub: boolean; }
export interface TaskView { id: string; subject: string; status: string; blockedBy: string[]; }
export interface DiscoveryDone {
  roots: string[];
  projects: number;
  sessions: number;
  projectDirs?: Array<{ slug: string; path: string; exists: boolean }>;
}

export type MapEventMsg =
  | { event: "agentUpserted"; data: AgentView }
  | { event: "tasksUpserted"; data: { sessionId: string; tasks: TaskView[] } }
  | { event: "agentRemoved"; data: { id: string } }
  | { event: "discoveryDone"; data: DiscoveryDone };

export class Store {
  agents = new Map<string, AgentView>();
  tasks = new Map<string, TaskView[]>();
  discovery: DiscoveryDone | null = null;
  onchange: (() => void) | null = null;

  apply(msg: MapEventMsg): void {
    switch (msg.event) {
      case "agentUpserted": this.agents.set(msg.data.id, msg.data); break;
      case "agentRemoved": this.agents.delete(msg.data.id); break;
      case "tasksUpserted": this.tasks.set(msg.data.sessionId, msg.data.tasks); break;
      case "discoveryDone": this.discovery = msg.data; break;
    }
    this.onchange?.();
  }

  nodes(): AgentView[] { return [...this.agents.values()]; }

  edges(): Array<{ from: string; to: string }> {
    const out: Array<{ from: string; to: string }> = [];
    for (const a of this.agents.values()) {
      if (a.parentId && this.agents.has(a.parentId)) out.push({ from: a.parentId, to: a.id });
    }
    return out;
  }
}
