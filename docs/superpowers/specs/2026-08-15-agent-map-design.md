# Kersy — Phase 1 (Agent Map) design spec

**App name:** Kersy (owner-chosen, 2026-08-15)
**Date:** 2026-08-15
**Status:** Approved by owner (Joe Marie Bonilla)
**Repo:** `~/workspace/kersy` (standalone personal tool; not part of `www/`)

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

## Launch-time auto-discovery (automap)

On startup the app detects the OS and probes for Claude Code data roots itself — no configuration needed:

1. **Candidate roots, in order:** `$CLAUDE_CONFIG_DIR` if set; `<home>/.claude` (default on Linux/macOS/Windows, via the `dirs` crate); `<XDG_CONFIG_HOME|~/.config>/claude` (Linux XDG variant). Every candidate that exists is probed — multiple roots can be active at once.
2. **Validation:** a root counts as an install if it contains a `projects/` dir with at least one `*.jsonl` (or session subdir). `tasks/` is optional.
3. **Automap:** all valid roots are watched simultaneously and their sessions merge into the one graph; a root badge distinguishes them if more than one is found.
4. **Feedback UI:** a brief discovery splash lists what was probed and what was found ("Found Claude Code data: ~/.claude — 11 projects, 42 sessions"). If nothing is found, the empty-state screen shows the probed paths and a manual "add folder…" picker, which is also available later in settings for non-standard setups.
5. Discovered/added roots persist in the app's config file so subsequent launches map instantly, but re-probe still runs each launch to pick up new installs.

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

- **`ToolAdapter` trait (flexibility seam, owner-required):** everything tool-specific — discovery of roots, transcript/task parsing, status derivation — sits behind a per-tool adapter trait with optional capabilities. Phase 1 ships exactly one adapter (Claude Code), but core and UI depend only on the trait, so future tools (Codex, Gemini CLI, …) are single added modules. No speculative code for other tools in Phase 1 — only the seam.
- **Discovery module:** implements the launch-time automap above via the adapters; returns the set of valid data roots. Unit-tested with fake home dirs.
- **Watcher:** `notify-debouncer-full` (official notify companion crate — merges rename pairs, dedups creates, suppresses modify-after-create) over `<root>/projects` and `<root>/tasks` for every discovered root; absolute paths; watch the parent roots recursively (Linux/inotify ends a watch when the watched object is deleted, so never watch individual session files); `EventKindMask::CORE` filtering. Debounce timeout ~250 ms.
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

- Core watcher spawned in the `.setup()` hook via `tauri::async_runtime::spawn`; state registered with `.manage()` (no `Arc` — Tauri owns sharing); async commands use `tokio::sync::Mutex` and return `Result`.
- Diff stream delivered over a `tauri::ipc::Channel<MapEvent>` (the documented streaming mechanism) with a serde-tagged event enum; one-off notices (discovery results, watcher-degraded) via global `app.emit`.
- Commands (invoked from UI): `get_full_state()`, `get_agent_events(agent_id)` (ring buffer dump), `parse_stale_session(uuid)`.
- No network access; everything bundled. CSP set explicitly in `tauri.conf.json`: `default-src 'self'; connect-src ipc: http://ipc.localhost`. Capabilities: `core:default` only — no shell/http/fs plugins exposed to the frontend; all filesystem access stays in our own Rust commands.

### UI (webview)

- **Map view:** canvas force-directed graph (d3-force simulation, custom canvas renderer for performance).
  - Node hierarchy: project → session → agent (edges from `parentAgentId`).
  - **Animation:** active nodes pulse; new agents spring in; finished agents fade to gray; stale sessions shrink/dim so live work dominates. Each active node carries a live one-line label of its current activity.
- **Drill-in panel** (click a node): agent type + description, streaming activity feed (last ~50 events with timestamps — shell commands shown verbatim), and the session's task board (grouped by status; `blockedBy` edges optionally overlaid on the graph as dashed links). Plus three trust features (see roadmap's weakness→feature map; all verified derivable from transcript data):
  - **Verification receipts:** the test/lint/build commands the session actually ran, with real stdout snippets and exit status (`toolUseResult.stdout`); a session that finished with zero verification commands gets a warning badge on its node.
  - **Context gauge:** live context size per session from `message.usage.cache_read_input_tokens`, with amber/red thresholds — long-context drift made visible.
  - **Files touched:** deduped list of every file the session edited/wrote — scope creep stands out immediately.
- **Task list pane (always visible):** a dedicated docked pane — not just drill-in — aggregating task boards from `~/.claude/tasks` across sessions: in-progress first, then pending with blocked-by indicators, then completed (collapsed). Clicking a task highlights the session/agents working on it in the graph. This is the owner's live todo view.
- **Top bar:** filter by project, "live only" toggle (hides stale), pause-layout button.
- Dark theme default (matches terminal workflow); light supported.

## Lightweight constraints (hard requirements, owner 2026-08-15)

Kersy must stay a background-friendly tool, not another Electron hog. These are acceptance criteria, checked before any release build:

- **No frontend framework, no bundler bloat:** plain TypeScript + canvas; the only runtime JS dependency is `d3-force` (layout math only, ~15 KB gzip). No React/Vue, no component library, no CSS framework — hand-written CSS.
- **Minimal Rust dependency set:** `tauri`, `serde`/`serde_json`, `notify` + `notify-debouncer-full`, `tokio`, `dirs`, and a logging facade. Every additional crate needs a stated reason in the PR.
- **Binary/installer ≤ 15 MB**; uses the OS webview (never bundles a browser engine).
- **Idle cost ~zero:** event-driven end to end — no polling loops; when no transcript is being written, CPU sits at 0% and the force simulation is paused (it also pauses when the window is hidden/minimized).
- **Memory as low as possible (owner priority).** Two distinct budgets, because in a Tauri app the OS webview owns most of the RAM and we control the rest:
  - **Rust process: ≤ 50 MB RSS typical, ≤ 100 MB worst case.** Enforced by design, not hope: raw JSON lines are parsed and **dropped immediately** — only the small derived state survives (an `AgentNode` is a few hundred bytes, not its transcript); byte-offset tailing (a transcript is never held or re-read); ring buffers ~50 events/agent storing truncated summaries (commands clipped to ~200 chars); repeated strings (project slugs, agent types, file paths) interned; stub nodes + lazy parse for sessions older than 7 days, and lazily-parsed detail is **evicted again** when the drill-in closes.
  - **Webview:** minimized by having almost nothing in it — one canvas, no per-node DOM, no framework heap; the UI holds only the same derived state mirrored from Rust. Its floor (~50–100 MB) is set by the OS webview engine itself and is the unavoidable cost of any GUI; if that floor ever matters, the fallback is a ratatui terminal frontend on the same core crate.
  - A memory figure (Rust RSS) is shown in the app's status bar so regressions are visible in daily use.
- **Fast start:** window visible < 1 s; discovery + initial scan streams in behind it (splash states, never blocks).
- **Renderer stays cheap:** one canvas, one `requestAnimationFrame` loop that stops when the simulation settles; no per-node DOM elements.

## Distribution

- `tauri build` → `.rpm` + AppImage on this Fedora machine now.
- Same repo produces `.msi` (Windows) and `.dmg` (macOS) when built on those OSes; CI matrix later if wanted.
- App id `dev.jmbonilla.kersy` (personal project — no company branding anywhere in the app, ids, or installers), product name "Kersy", icon in launcher, single ~5–10 MB binary using the OS webview.

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
