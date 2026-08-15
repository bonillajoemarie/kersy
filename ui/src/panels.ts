import { invoke } from "@tauri-apps/api/core";
import type { AgentView, Store, TaskView } from "./store";

interface AgentEventDto { label: string; tool: string; isVerification: boolean; stdout: string | null; seq: number; }

const el = (tag: string, cls: string, text = ""): HTMLElement => {
  const e = document.createElement(tag); e.className = cls; e.textContent = text; return e;
};

export function renderTasks(store: Store, container: HTMLElement, onPick: (sessionId: string) => void): void {
  container.replaceChildren(el("h3", "pane-title", "Tasks"));
  const buckets: Record<string, Array<{ sid: string; t: TaskView }>> = { in_progress: [], pending: [], completed: [] };
  for (const [sid, tasks] of store.tasks) for (const t of tasks) (buckets[t.status] ?? buckets.pending).push({ sid, t });
  for (const status of ["in_progress", "pending", "completed"] as const) {
    if (!buckets[status].length) continue;
    const group = el("details", `task-group ${status}`) as HTMLDetailsElement;
    group.open = status !== "completed";
    group.append(el("summary", "", `${status.replace("_", " ")} (${buckets[status].length})`));
    for (const { sid, t } of buckets[status]) {
      const row = el("div", `task task-${status}`, t.subject);
      if (t.blockedBy.length) row.append(el("span", "blocked", ` ⛔ blocked by ${t.blockedBy.join(", ")}`));
      row.onclick = () => onPick(sid); // sid is a sessionId, which IS the root agent's id — store.agents.get(sid) resolves
      group.append(row);
    }
    container.append(group);
  }
}

// `isValid` reports whether this call is still the newest drill-in request. main.ts increments
// a generation token per call and passes `() => gen === drillinGen`; the initial synchronous
// clear+render below always belongs to the newest call by definition (it runs before any other
// call can bump the token further), so it needs no guard — only DOM mutations made after an
// `await` can race with a newer call and must check `isValid()` before touching the container.
export async function renderDrillin(agent: AgentView, container: HTMLElement, isValid: () => boolean = () => true): Promise<void> {
  container.hidden = false;
  container.replaceChildren(
    el("h3", "pane-title", `${agent.agentType} — ${agent.description || agent.id}`),
    el("div", "cmd", agent.currentActivity),
  );
  const gauge = el("div", "gauge");
  const pct = Math.min(100, (agent.contextTokens / 180_000) * 100);
  const cls = pct > 85 ? "error" : pct > 60 ? "warn" : "info";
  gauge.append(el("div", `gauge-fill ${cls}`, `${Math.round(agent.contextTokens / 1000)}k ctx`));
  (gauge.firstChild as HTMLElement).style.width = `${pct}%`;
  container.append(gauge);
  if (agent.verificationRuns === 0 && !agent.stub) container.append(el("div", "badge error", "⚠ no verification commands run"));
  const files = el("details", "files");
  files.append(el("summary", "", `files touched (${agent.filesTouched.length})`));
  for (const f of agent.filesTouched) files.append(el("div", "cmd", f));
  container.append(files);
  if (agent.stub) {
    await invoke("open_stub", { sessionId: agent.sessionId });
    if (!isValid()) return; // no DOM mutation follows here today, but guard in case one is added
    return;
  }
  const events = await invoke<AgentEventDto[]>("get_agent_events", { agentId: agent.id });
  if (!isValid()) return;
  const feed = el("div", "feed");
  for (const e of [...events].reverse()) {
    const row = el("div", `evt ${e.isVerification ? "verify" : ""}`, `${e.tool}: ${e.label}`);
    if (e.stdout) row.append(el("pre", "cmd stdout", e.stdout));
    feed.append(row);
  }
  container.append(feed);
}
