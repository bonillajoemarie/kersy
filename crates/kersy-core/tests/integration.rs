use kersy_core::adapter::DataRoot;
use kersy_core::engine::Engine;
use kersy_core::model::MapEvent;
use kersy_core::watcher::{spawn_watcher, FsChange};
use std::time::{Duration, SystemTime};

#[test]
fn watcher_to_engine_end_to_end() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("projects/-p")).unwrap();
    std::fs::create_dir_all(d.path().join("tasks")).unwrap();
    let root = DataRoot { tool: "claude-code", path: d.path().to_path_buf() };
    let (tx, rx) = std::sync::mpsc::channel();
    let _guard = spawn_watcher(std::slice::from_ref(&root), tx).unwrap();
    let mut engine = Engine::new(vec![root]);

    std::fs::write(
        d.path().join("projects/-p/sess-9.jsonl"),
        concat!(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#, "\n"),
    ).unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut got = false;
    while std::time::Instant::now() < deadline {
        if let Ok(change) = rx.recv_timeout(Duration::from_millis(500)) {
            let evs = match change {
                FsChange::Changed(p) => engine.on_path_changed(&p, SystemTime::now()),
                FsChange::Removed(p) => engine.on_path_removed(&p),
            };
            if evs.iter().any(|e| matches!(e, MapEvent::AgentUpserted(s) if s.id == "sess-9")) { got = true; break; }
        }
    }
    assert!(got, "no AgentUpserted for sess-9 within 5s");
}
