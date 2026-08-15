# Phase 1 — official-docs grounding

Verified 2026-08-15 against official documentation (via Context7). Each item cites its source; implementation must follow these, not memory.

## Tauri 2 (v2.tauri.app)

1. **Rust→frontend streaming** (`/develop/calling-frontend`): two official mechanisms.
   - `app.emit(...)` (global events) — broadcast to all listeners/webviews.
   - `tauri::ipc::Channel<T>` — the documented pattern for **streaming ordered data** to the frontend (their example: download progress), with a serde-tagged enum payload (`#[serde(tag="event", content="data", rename_all="camelCase")]`).
   - **Decision:** the watcher's diff stream uses a `Channel<MapEvent>` handed in by the UI on subscribe (ordered, faster, typed enum); one-off notices (discovery splash results, watcher-degraded badge) use global events.
2. **Background work + state** (`/develop/state-management`, `/learn/splashscreen`):
   - Long-running work starts in the `.setup()` hook via `tauri::async_runtime::spawn` — "don't write code before Tauri starts".
   - Shared state registered with `.manage(...)`, accessed as `tauri::State<...>`; **no `Arc` needed** (Tauri owns sharing); threads that outlive a command get a cloned `AppHandle` and fetch state through it.
   - Async commands that touch state use `tokio::sync::Mutex` and **must return `Result`**.
3. **Security** (`/security/csp`, `/security/http-headers`, `/reference/config`):
   - CSP is only active if set in `tauri.conf.json` → `app.security.csp`. Baseline: `default-src 'self'; connect-src ipc: http://ipc.localhost` (Tauri appends its own nonces/hashes for bundled assets at compile time). Keep it this tight — the app has no remote content.
   - Capabilities: start from `core:default` only; add per-plugin permissions explicitly (`tauri permission add`). No shell/http/fs plugin exposure to the frontend — all filesystem access stays in our own Rust commands.
4. **Bundling** (`/distribute`): `tauri build` produces the per-OS installers; nothing in our design conflicts with the documented pipeline.

## notify / notify-debouncer-full (docs.rs, notify-rs wiki)

5. **Use `notify-debouncer-full`, not hand-rolled debounce** — it is the official companion crate and does what we'd otherwise write badly: merges rename From/To pairs, rewrites pre-rename paths, suppresses modify-after-create, dedups creates, single remove for a deleted dir. `new_debouncer(timeout, tick_rate /*None → timeout/4*/, handler)`, then `.watch(path, RecursiveMode::Recursive)`. Handler can be a channel sender.
6. **Watch absolute paths** (v8→v9 upgrade guide) — relative paths change event-path reporting.
7. **Linux/inotify caveat** (Event Guide wiki): *if a watched object is removed, its watch ends*. Therefore watch the **parent roots** (`<root>/projects`, `<root>/tasks`) recursively rather than individual session files, so deleted/recreated sessions keep flowing.
8. Event-kind filtering exists (`Config::with_event_kinds(EventKindMask::CORE)`) — use it to drop access-event noise on Linux.

## d3-force

9. Official docs: https://d3js.org/d3-force (source: github.com/d3/d3-force). Use `forceSimulation` with `forceLink`/`forceManyBody`/`forceCenter`, drive our own canvas render from the `tick` handler, and call `simulation.alphaTarget()` on node add/remove to reheat the layout (the documented interaction pattern). No DOM/SVG binding — d3-force is renderer-agnostic by design.

## Spec deltas applied from this research

- Watcher section now names `notify-debouncer-full` (was: raw recommended-watcher + hand debounce).
- IPC: diff stream via `tauri::ipc::Channel`, not global emit.
- Security section: explicit CSP string + `core:default`-only capability baseline.
