# Phase 1 — items for owner review (recorded before SDD workspace cleanup, 2026-08-15)

1. **aiTitle ruling (autonomous):** plan/test assumed session-title key `"title"`; all real transcripts use `"aiTitle"`. Ruled reality governs; parser accepts both. Confirm.
2. **RAM budget wording (PARKED):** "Rust RSS ≤ 50 MB" is unmeasurable as written on Linux — the main process hosts GTK/WebKitGTK (measured: 81 MB PSS main + 138 MB WebKit child at true idle = the webview floor the spec itself anticipated). Decide: re-word to core-state footprint, or accept the floor. Installer budget PASSES (RPM 3.0 MB ≤ 15 MB). Idle CPU now verified 0.0%.
3. **CLAUDE_CONFIG_DIR semantics:** Kersy discovery is additive (env root + ~/.claude both watched); Claude Code itself treats the env var as an override. Backlog decision.
4. **Deferred minors (all recorded, none load-bearing):** HiDPI rendering softness; same-line fact-ordering assumption (safe on real data); deselect doesn't bump drill-in generation (inert); AppImage is 103 MB (expected — bundles GTK; RPM is the budget artifact).
5. **Spec gaps → Phase 1.5/backlog:** add-folder picker + root persistence, subagent "done" status, per-file parse-warning surface, watcher-degraded badge.
