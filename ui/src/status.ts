import type { AgentView } from "./store";

export const ACTIVE_MS = 30_000;
export const IDLE_MS = 600_000;

// The backend snapshot's `status` string is frozen at the moment the event was emitted — it
// never updates again until the next event arrives for that agent. A session that goes quiet
// therefore reads "active" forever in the UI even though no bytes are moving, which is exactly
// the 0%-idle violation this derives away: status is recomputed every frame from wall-clock time
// against the agent's last known activity instant, so it decays to idle/stale on its own.
export function statusOf(n: AgentView, nowMs: number = Date.now()): "active" | "idle" | "stale" {
  if (n.stub) return "stale";
  if (!n.lastActivityMs) return n.status; // fallback: no timestamp to derive from yet
  const age = nowMs - n.lastActivityMs;
  if (age < ACTIVE_MS) return "active";
  if (age < IDLE_MS) return "idle";
  return "stale";
}
