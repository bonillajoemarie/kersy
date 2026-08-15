import type { AgentView } from "./store";

/**
 * Get the last path segment, handling both absolute paths and slug forms.
 * /home/u/kersy -> kersy
 * -home-u-kersy -> kersy
 */
function lastSegment(path: string): string {
  // Handle real paths (contain /)
  if (path.includes("/")) {
    const cleaned = path.replace(/\/+$/, "");
    const segments = cleaned.split("/").filter((s) => s.length > 0);
    return segments[segments.length - 1] || "unknown";
  }

  // Handle slug forms (only hyphens, leading with -)
  if (path.includes("-")) {
    const cleaned = path.replace(/-+$/, "");
    const segments = cleaned.split("-").filter((s) => s.length > 0);
    return segments[segments.length - 1] || "unknown";
  }

  // Single segment
  return path || "unknown";
}

/**
 * Display a human-readable name for an agent, never showing its raw id.
 *
 * For root agents (no parent): description → currentActivity → "Session in <folder>"
 * For subagents: description → agentType
 *
 * @param a The agent to display
 * @param projectPath Optional override for the project path (used for "Session in" fallback)
 */
export function displayAgent(a: AgentView, projectPath?: string): string {
  const isRoot = !a.parentId;

  if (isRoot) {
    // Root precedence: description → currentActivity → "Session in <folder>"
    if (a.description.trim()) {
      return a.description;
    }
    if (a.currentActivity.trim()) {
      return a.currentActivity;
    }
    // Fall back to "Session in <folder>"
    const projectPathToUse = projectPath || a.project;
    const folderName = lastSegment(projectPathToUse);
    return `Session in ${folderName}`;
  } else {
    // Subagent precedence: description → agentType
    if (a.description.trim()) {
      return a.description;
    }
    return a.agentType;
  }
}

/**
 * Display a human-readable name for a project.
 * Extracts the last path segment from absolute paths or slug forms.
 *
 * @param slugOrPath Path like "/home/u/kersy" or slug like "-home-u-kersy"
 */
export function displayProject(slugOrPath: string): string {
  return lastSegment(slugOrPath);
}

/**
 * Format the time since last activity as a human-readable age label.
 *
 * 0ms or invalid -> "unknown"
 * <60s -> "just now"
 * <1h -> "N min"
 * <24h -> "N h"
 * else -> "N days"
 *
 * @param lastActivityMs Last activity timestamp in milliseconds
 * @param now Current time in milliseconds
 */
export function ageLabel(lastActivityMs: number, now: number): string {
  if (!lastActivityMs || lastActivityMs <= 0) {
    return "unknown";
  }

  const ageMs = now - lastActivityMs;

  // Just now: < 60 seconds
  if (ageMs < 60000) {
    return "just now";
  }

  // Minutes: >= 60s and < 1 hour
  if (ageMs < 3600000) {
    const minutes = Math.round(ageMs / 60000);
    return `${minutes} min`;
  }

  // Hours: >= 1 hour and < 24 hours
  if (ageMs < 86400000) {
    const hours = Math.round(ageMs / 3600000);
    return `${hours} h`;
  }

  // Days: >= 24 hours
  const days = Math.round(ageMs / 86400000);
  return `${days} day${days === 1 ? "" : "s"}`;
}
