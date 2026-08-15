use crate::adapter::DataRoot;
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::time::Duration;

pub enum FsChange {
    Changed(PathBuf),
    Removed(PathBuf),
}

pub fn spawn_watcher(
    roots: &[DataRoot],
    tx: Sender<FsChange>,
) -> notify::Result<Debouncer<RecommendedWatcher, RecommendedCache>> {
    let mut debouncer = new_debouncer(Duration::from_millis(250), None, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            for ev in events {
                for path in &ev.paths {
                    let change = match ev.kind {
                        EventKind::Remove(_) => FsChange::Removed(path.clone()),
                        EventKind::Create(_) | EventKind::Modify(_) => FsChange::Changed(path.clone()),
                        _ => continue,
                    };
                    let _ = tx.send(change);
                }
            }
        }
    })?;
    for root in roots {
        for sub in ["projects", "tasks"] {
            let p = root.path.join(sub);
            if p.is_dir() {
                debouncer.watch(&p, RecursiveMode::Recursive)?;
            }
        }
    }
    Ok(debouncer)
}
