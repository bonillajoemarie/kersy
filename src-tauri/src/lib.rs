use kersy_core::adapter::{discover, ToolAdapter};
use kersy_core::claude::ClaudeCodeAdapter;
use kersy_core::engine::Engine;
use kersy_core::model::{AgentEventDto, MapEvent};
use kersy_core::watcher::{spawn_watcher, FsChange};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::ipc::Channel;
use tauri::{Manager, State};

struct App {
    engine: Mutex<Engine>,
    channels: Mutex<Vec<Channel<MapEvent>>>,
    // `Engine::full_snapshot` re-derives AgentUpserted/TasksUpserted from world state, but it
    // does not include DiscoveryDone (that's an event, not part of the world). Stash the one
    // produced by the startup `initial_scan` so every `subscribe` can still replay it.
    discovery_done: MapEvent,
}

/// Lock a `Mutex`, recovering the guard on poison instead of propagating the panic — a panicked
/// command handler must not permanently wedge the watcher thread (or any other lock user) behind
/// a poisoned mutex.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn broadcast(channels: &Mutex<Vec<Channel<MapEvent>>>, events: &[MapEvent]) {
    let mut chans = lock(channels);
    chans.retain(|c| events.iter().all(|e| c.send(e.clone()).is_ok()));
}

#[tauri::command]
fn subscribe(state: State<'_, App>, on_event: Channel<MapEvent>) {
    // Hold the engine lock across the channels-lock acquisition and registration so the
    // snapshot + DiscoveryDone send and the push onto `channels` are atomic with respect to the
    // watcher thread (which always takes engine, then — only if there are events — channels).
    // Same lock order here (engine, then channels), so no deadlock; without this, a watcher
    // mutation+broadcast could land in the window between snapshotting and registering, and the
    // new subscriber would miss it permanently.
    let eng = lock(&state.engine);
    let snapshot = eng.full_snapshot(SystemTime::now());
    let mut chans = lock(&state.channels);
    for ev in &snapshot {
        let _ = on_event.send(ev.clone());
    }
    let _ = on_event.send(state.discovery_done.clone());
    chans.push(on_event);
}

#[tauri::command]
fn get_agent_events(state: State<'_, App>, agent_id: String) -> Vec<AgentEventDto> {
    lock(&state.engine).agent_events(&agent_id)
}

#[tauri::command]
fn open_stub(state: State<'_, App>, session_id: String) {
    let evs = lock(&state.engine).parse_stub(&session_id, SystemTime::now());
    broadcast(&state.channels, &evs);
}

#[tauri::command]
fn rust_rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}

pub fn run() {
    let home = dirs::home_dir().expect("no home dir");
    let adapters: Vec<Box<dyn ToolAdapter>> = vec![Box::new(ClaudeCodeAdapter)];
    let roots = discover(&adapters, &home, &|k| std::env::var(k).ok());

    // Populate engine state before it moves into `manage()`; events are re-derived later via
    // `full_snapshot` on each `subscribe`, except DiscoveryDone which we keep separately below.
    let mut engine = Engine::new(roots.clone());
    let initial_events = engine.initial_scan(SystemTime::now());
    let discovery_done = initial_events
        .into_iter()
        .find(|e| matches!(e, MapEvent::DiscoveryDone { .. }))
        .unwrap_or(MapEvent::DiscoveryDone { roots: vec![], projects: 0, sessions: 0 });

    tauri::Builder::default()
        .manage(App {
            engine: Mutex::new(engine),
            channels: Mutex::new(Vec::new()),
            discovery_done,
        })
        .invoke_handler(tauri::generate_handler![
            subscribe,
            get_agent_events,
            open_stub,
            rust_rss_kb
        ])
        .setup(move |app| {
            // Start the fs watcher on a plain thread (notify has its own threads; mpsc is sync).
            let handle = app.handle().clone();
            let (tx, rx) = std::sync::mpsc::channel::<FsChange>();
            let debouncer = spawn_watcher(&roots, tx)?;
            std::thread::spawn(move || {
                let _keep_alive = debouncer;
                for change in rx {
                    let state: State<App> = handle.state();
                    let evs = {
                        let mut eng = lock(&state.engine);
                        match change {
                            FsChange::Changed(p) => eng.on_path_changed(&p, SystemTime::now()),
                            FsChange::Removed(p) => eng.on_path_removed(&p),
                        }
                    };
                    if !evs.is_empty() {
                        broadcast(&state.channels, &evs);
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Kersy");
}
