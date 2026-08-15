# Agent Map — design spec

**Date:** 2026-08-15
**Status:** Approved by owner (Joe Marie Bonilla)
**Repo:** `~/workspace/agent-map` (standalone personal tool; not part of `www/`)

## What it is

A real, installable desktop application (Rust + Tauri 2) that shows — live, machine-wide — every Claude Code session, its subagent tree, the task board of each session, and the exact tool/shell command each agent is running right now, rendered as a physics-animated force-directed graph.

## Why

Subagent-driven-development runs (and ordinary sessions) spawn agents whose activity is invisible unless you tail JSONL files by hand. All the data already exists on disk; this app makes it observable in real time.

## Data sources (verified on this machine, 2026-08-15)

| Source | Path | Gives |
|---|---|---|
| Session transcripts | `~/.claude/projects/<project-slug>/<session-uuid>.jsonl` | Append-only event log: assistant/user turns, `tool_use` records (incl. full `Bash` `input.command`, `Edit`/`Write` file paths, `Agent` spawns), timestamps |
| Subagent transcripts | `~/.claude/projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl` | Same event shape, per subagent |
| Subagent metadata | `.../subagents/agent-<id>.meta.json` | `agentType`, `description`, `toolUseId`, `parentAgentId`, `spawnDepth` → the agent **tree** |
| Task boards | `~/.claude/tasks/<session-uuid>/<n>.json` | `subject`, `description`, `status` (`pending`/`in_progress`/`completed`), `blocks`, `blockedBy` |

Notes:
- Files are written concurrently by live Claude Code processes; the last line may be partial.
- Project slug encodes the working directory (`-home-jmbonilla-workspace` → `/home/jmbonilla/workspace`).
- Home dir resolved with the `dirs` crate → same paths work on Linux/macOS/Windows.

## Architecture

Two layers, one binary:

```
agent-map/
  crates/agent-map-core/   # plain Rust lib: watcher + parser + state model (GUI-free, unit-testable)
  src-tauri/               # Tauri 2 shell: wires core to the window, emits events
  ui/                      # TypeScript + canvas frontend (d3-force layout, no framework)
```

### agent-map-core (Rust library crate)

- **Watcher:** `notify` (recommended-watcher) over `~/.claude/projects` and `~/.claude/tasks`, debounced ~250 ms.
- **Tailer:** per-file byte offset map; on change, read only the new bytes, split lines, `serde_json` each. A trailing partial line is buffered until its newline arrives; a malformed complete line is skipped and counted — never fatal.
- **State model** (single source of truth, behind `tokio::sync::RwLock`):
  - `Project { slug, path, sessions }`
  - `Session { uuid, title (from ai-title records), last_activity, agents, tasks }`
  - `AgentNode { id, agent_type, description, parent_id, depth, status, current_activity, recent_events (ring buffer ~50) }`
  - `Task { id, subject, status, blocks, blocked_by }`
  - `Activity` = latest tool_use summary: `Bash("pest --parallel")`, `Edit("app/.../AssignChat.php")`, `Read(...)`, `Agent(spawn)`, or `Thinking/Responding`.
- **Status derivation** (no PID tracking; purely from write recency):
  - `active`: transcript appended within 30 s
  - `idle`: 30 s – 10 min
  - `done/stale`: > 10 min (subagent with a final result record → `done`)
- **Startup:** full scan of existing files (bounded: only sessions with mtime < 7 days are parsed in full; older ones get a stub node, lazily parsed on click).
- **Output:** diff events (`AgentUpdated`, `SessionUpdated`, `TaskUpdated`, `NodeAdded`, `NodeRemoved`) on a broadcast channel.

### Tauri shell (src-tauri)

- Subscribes to the core's channel; forwards diffs to the webview via `emit` (Tauri events).
- Commands (invoked from UI): `get_full_state()`, `get_agent_events(agent_id)` (ring buffer dump), `parse_stale_session(uuid)`.
- No network access; CSP locked down; everything bundled.

### UI (webview)

- **Map view:** canvas force-directed graph (d3-force simulation, custom canvas renderer for performance).
  - Node hierarchy: project → session → agent (edges from `parentAgentId`).
  - **Animation:** active nodes pulse; new agents spring in; finished agents fade to gray; stale sessions shrink/dim so live work dominates. Each active node carries a live one-line label of its current activity.
- **Drill-in panel** (click a node): agent type + description, streaming activity feed (last ~50 events with timestamps — shell commands shown verbatim), and the session's task board (grouped by status; `blockedBy` edges optionally overlaid on the graph as dashed links).
- **Top bar:** filter by project, "live only" toggle (hides stale), pause-layout button.
- Dark theme default (matches terminal workflow); light supported.

## Distribution

- `tauri build` → `.rpm` + AppImage on this Fedora machine now.
- Same repo produces `.msi` (Windows) and `.dmg` (macOS) when built on those OSes; CI matrix later if wanted.
- App id `ph.flowerstore.agentmap`, icon in launcher, single ~5–10 MB binary using the OS webview.

## Error handling

- Watcher errors → log + retry with backoff; UI shows a "watching degraded" badge, never crashes.
- JSONL parse failures → skip line, count it, surface a per-file warning in drill-in if excessive.
- Missing `~/.claude` dirs (fresh machine) → empty-state screen with the expected path.
- File deleted mid-tail (session cleanup) → drop offsets, remove node with fade-out.

## Testing

- `agent-map-core` unit tests against fixture transcripts (real files from this machine, secrets scrubbed): parser shapes, tree building from `meta.json`, status derivation with injected clock, partial-line handling, task-file parsing.
- Integration test: fixture dir + simulated appends → assert emitted diff sequence.
- UI: type-checked TS; graph logic (node diff application) unit-tested with Vitest. Visual behavior verified manually.

## Out of scope (v1)

- Controlling agents (stop/steer) — read-only monitor.
- Historical analytics/persistence — state is rebuilt from files each launch.
- Remote machines / cloud sessions — local filesystem only.
- Token/cost accounting.

## Risks

- **Transcript format is undocumented and may change** between Claude Code versions. Mitigation: parser is defensive (unknown record types ignored), fixtures pinned, core isolated so format churn touches one module.
- Very large transcripts (>100 MB) — mitigated by offset tailing and the 7-day full-parse cutoff.
