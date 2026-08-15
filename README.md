# Kersy

Kersy is a desktop app that renders a live, animated map of your Claude Code
agent sessions — the main session, any subagents it spawns, and the tasks
they work on — as a GPU-accelerated graph (WebGL2, with a Canvas2D fallback)
next to a Darcula-themed control panel. It watches your local Claude Code
state on disk, shows verification receipts as each agent step completes, and
tracks a per-session context-usage gauge, all without contacting any network
service or the agents themselves.

## Install

Prebuilt bundles (Linux only, Phase 1):

- Download the `.rpm` or `.AppImage` from the project's releases.
- RPM: `sudo dnf install ./Kersy-<version>-1.x86_64.rpm`, then launch `kersy`.
- AppImage: `chmod +x Kersy_<version>_amd64.AppImage && ./Kersy_<version>_amd64.AppImage`.

Or build it yourself:

```bash
cargo tauri build
```

Bundles land in `target/release/bundle/{rpm,appimage}/`.

## How it finds your sessions (automap)

Kersy probes, in order, for a Claude Code config root containing a `projects/`
directory with at least one `.jsonl` transcript:

1. `$CLAUDE_CONFIG_DIR` (if set)
2. `~/.claude`
3. `$XDG_CONFIG_HOME/claude` (or `~/.config/claude` if unset)

The first candidate that exists and validates is used. Nothing is written
back to these directories — Kersy only reads and watches them (via inotify)
for session, subagent, and task-file changes.

## Budgets

| Budget | Target | Notes |
|---|---|---|
| Installer size (RPM) | ≤ 15 MB | RPM depends on system WebKitGTK; this is the budget artifact |
| AppImage size | best-effort | bundles the full GTK/WebKitGTK dependency closure, so it runs much larger than the RPM by design |
| Rust process RSS | ≤ 50 MB typical | steady-state, one active watched session |
| Idle CPU | ~0% | when no watched files are changing |

## Development

```bash
cargo test -p kersy-core       # core discovery/parsing/tailer/status logic
npm --prefix ui run test       # frontend sim/store/render unit tests
npm --prefix ui run build      # type-check + production frontend build
cargo tauri dev                # run the app in dev mode
cargo tauri build               # release build + installers
```

## Design docs

Specs and per-task implementation notes live under
[`docs/superpowers/specs/`](docs/superpowers/specs/).
