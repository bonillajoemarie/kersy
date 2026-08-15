use crate::adapter::DataRoot;
use crate::claude::{classify, WatchedPath};
use crate::model::{AgentEventDto, AgentState, MapEvent, TaskSnapshot, World};
use crate::parser::{parse_line, Fact};
use crate::status;
use crate::tailer::Tailer;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const STUB_AGE: Duration = Duration::from_secs(7 * 86_400);

pub struct Engine {
    world: World,
    tailer: Tailer,
    roots: Vec<DataRoot>,
}

impl Engine {
    pub fn new(roots: Vec<DataRoot>) -> Self {
        Self { world: World::default(), tailer: Tailer::new(), roots }
    }

    fn agent_id(session: &str, agent: Option<&str>) -> String {
        match agent { Some(a) => format!("{session}/{a}"), None => session.to_string() }
    }

    fn root_of(&self, path: &Path) -> Option<DataRoot> {
        self.roots.iter().find(|r| path.starts_with(&r.path)).cloned()
    }

    fn ensure_agent(world: &mut World, id: &str, session: &str, project: &str, tool: &str) {
        if !world.agents.contains_key(id) {
            world.agents.insert(id.to_string(),
                AgentState::new(id.to_string(), session.to_string(), project.to_string(), tool.to_string()));
        }
    }

    fn apply_facts(a: &mut AgentState, facts: Vec<Fact>, now: SystemTime) {
        for f in facts {
            match f {
                Fact::Title(t) => a.title = Some(t),
                Fact::Usage { context_tokens } => a.context_tokens = context_tokens,
                Fact::ToolResult { stdout } => {
                    if let Some(last) = a.recent.back_mut() { last.stdout = Some(stdout); }
                }
                Fact::ToolUse { tool, label, file, is_verification } => {
                    if let Some(fp) = &file { a.touch_file(fp); }
                    a.push_event(AgentEventDto { label, tool, is_verification, stdout: None, seq: 0 });
                }
            }
        }
        a.last_activity = now;
    }

    pub fn on_path_changed(&mut self, path: &Path, now: SystemTime) -> Vec<MapEvent> {
        let Some(root) = self.root_of(path) else { return vec![] };
        let (tool, rootp) = (root.tool, root.path.clone());
        match classify(&rootp, path) {
            WatchedPath::MainTranscript { project, session } => {
                let id = Self::agent_id(&session, None);
                Self::ensure_agent(&mut self.world, &id, &session, &project, tool);
                if self.world.agents[&id].stub { return vec![] } // stubs parse lazily
                let Ok(lines) = self.tailer.read_new_lines(path) else { return vec![] };
                let a = self.world.agents.get_mut(&id).unwrap();
                for l in &lines { Self::apply_facts(a, parse_line(l), now); }
                vec![MapEvent::AgentUpserted(a.snapshot(status::derive(a.last_activity, now)))]
            }
            WatchedPath::SubagentTranscript { project, session, agent } => {
                let id = Self::agent_id(&session, Some(&agent));
                Self::ensure_agent(&mut self.world, &id, &session, &project, tool);
                let Ok(lines) = self.tailer.read_new_lines(path) else { return vec![] };
                let a = self.world.agents.get_mut(&id).unwrap();
                if a.parent_id.is_none() { a.parent_id = Some(session.clone()); } // default: child of session
                for l in &lines { Self::apply_facts(a, parse_line(l), now); }
                vec![MapEvent::AgentUpserted(a.snapshot(status::derive(a.last_activity, now)))]
            }
            WatchedPath::SubagentMeta { project, session, agent } => {
                let id = Self::agent_id(&session, Some(&agent));
                Self::ensure_agent(&mut self.world, &id, &session, &project, tool);
                let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { return vec![] };
                let a = self.world.agents.get_mut(&id).unwrap();
                if let Some(t) = v["agentType"].as_str() { a.agent_type = t.to_string(); }
                if let Some(dsc) = v["description"].as_str() { a.description = dsc.to_string(); }
                a.parent_id = Some(match v["parentAgentId"].as_str() {
                    Some(pid) => Self::agent_id(&session, Some(pid)),
                    None => session.clone(),
                });
                a.last_activity = now;
                vec![MapEvent::AgentUpserted(a.snapshot(status::derive(a.last_activity, now)))]
            }
            WatchedPath::TaskFile { session } => {
                let dir = path.parent().unwrap().to_path_buf();
                let tasks = read_task_dir(&dir);
                self.world.tasks.insert(session.clone(), tasks.clone());
                vec![MapEvent::TasksUpserted { session_id: session, tasks }]
            }
            WatchedPath::Ignored => vec![],
        }
    }

    pub fn on_path_removed(&mut self, path: &Path) -> Vec<MapEvent> {
        self.tailer.forget(path);
        let Some(root) = self.root_of(path) else { return vec![] };
        match classify(&root.path, path) {
            WatchedPath::MainTranscript { session, .. } => {
                // remove root and all subagents of the session
                let ids: Vec<String> = self.world.agents.keys()
                    .filter(|k| **k == session || k.starts_with(&format!("{session}/")))
                    .cloned().collect();
                for id in &ids {
                    if let Some(a) = self.world.agents.remove(id) {
                        // forget the tailer state for subagent transcripts too, so a
                        // re-created session starts re-reading from byte 0
                        if let Some(agent) = id.strip_prefix(&format!("{session}/")) {
                            let tp = root.path.join("projects").join(&a.project).join(&session)
                                .join("subagents").join(format!("agent-{agent}.jsonl"));
                            self.tailer.forget(&tp);
                        }
                    }
                }
                ids.into_iter().map(|id| MapEvent::AgentRemoved { id }).collect()
            }
            WatchedPath::SubagentTranscript { session, agent, .. } => {
                let id = Self::agent_id(&session, Some(&agent));
                self.world.agents.remove(&id);
                vec![MapEvent::AgentRemoved { id }]
            }
            WatchedPath::TaskFile { session } => {
                let Some(dir) = path.parent() else { return vec![] };
                let tasks = read_task_dir(dir);
                if dir.exists() {
                    self.world.tasks.insert(session.clone(), tasks.clone());
                } else {
                    self.world.tasks.remove(&session);
                }
                vec![MapEvent::TasksUpserted { session_id: session, tasks }]
            }
            _ => vec![],
        }
    }

    pub fn initial_scan(&mut self, now: SystemTime) -> Vec<MapEvent> {
        let mut events = Vec::new();
        let mut sessions = 0u32;
        let mut projects = std::collections::BTreeSet::new();
        let roots: Vec<DataRoot> = self.roots.clone();
        for root in &roots {
            let Ok(projs) = std::fs::read_dir(root.path.join("projects")) else { continue };
            for proj in projs.flatten() {
                let Some(project) = proj.file_name().to_str().map(String::from) else { continue };
                let Ok(entries) = std::fs::read_dir(proj.path()) else { continue };
                for e in entries.flatten() {
                    let p: PathBuf = e.path();
                    if p.extension().is_some_and(|x| x == "jsonl") {
                        projects.insert(project.clone());
                        sessions += 1;
                        let old = e.metadata().ok()
                            .and_then(|m| m.modified().ok())
                            .map(|m| now.duration_since(m).map(|d| d > STUB_AGE).unwrap_or(false))
                            .unwrap_or(false);
                        if old {
                            let session = p.file_stem().unwrap().to_string_lossy().to_string();
                            let id = Self::agent_id(&session, None);
                            Self::ensure_agent(&mut self.world, &id, &session, &project, root.tool);
                            let a = self.world.agents.get_mut(&id).unwrap();
                            a.stub = true;
                            events.push(MapEvent::AgentUpserted(a.snapshot("stale")));
                        } else {
                            events.extend(self.on_path_changed(&p, now));
                            // also scan its subagents dir
                            let sub = proj.path().join(p.file_stem().unwrap()).join("subagents");
                            if let Ok(subs) = std::fs::read_dir(&sub) {
                                for s in subs.flatten() { events.extend(self.on_path_changed(&s.path(), now)); }
                            }
                        }
                    }
                }
            }
            let Ok(tdirs) = std::fs::read_dir(root.path.join("tasks")) else { continue };
            for td in tdirs.flatten() {
                if let Ok(fs) = std::fs::read_dir(td.path()) {
                    if let Some(f) = fs.flatten().find(|f| f.path().extension().is_some_and(|x| x == "json")) {
                        events.extend(self.on_path_changed(&f.path(), now));
                    }
                }
            }
        }
        events.push(MapEvent::DiscoveryDone {
            roots: roots.iter().map(|r| r.path.display().to_string()).collect(),
            projects: projects.len() as u32,
            sessions,
        });
        events
    }

    pub fn parse_stub(&mut self, session_id: &str, now: SystemTime) -> Vec<MapEvent> {
        let Some(a) = self.world.agents.get_mut(session_id) else { return vec![] };
        if !a.stub { return vec![] }
        a.stub = false;
        let (project, tool) = (a.project.clone(), a.tool.clone());
        let path = self.roots.iter().find(|r| r.tool == tool)
            .map(|r| r.path.join("projects").join(&project).join(format!("{session_id}.jsonl")));
        match path { Some(p) if p.exists() => self.on_path_changed(&p, now), _ => vec![] }
    }

    pub fn full_snapshot(&self, now: SystemTime) -> Vec<MapEvent> {
        let mut evs: Vec<MapEvent> = self.world.agents.values()
            .map(|a| MapEvent::AgentUpserted(a.snapshot(if a.stub { "stale" } else { status::derive(a.last_activity, now) })))
            .collect();
        for (sid, tasks) in &self.world.tasks {
            evs.push(MapEvent::TasksUpserted { session_id: sid.clone(), tasks: tasks.clone() });
        }
        evs
    }

    pub fn agent_events(&self, agent_id: &str) -> Vec<AgentEventDto> {
        self.world.agents.get(agent_id).map(|a| a.recent.iter().cloned().collect()).unwrap_or_default()
    }
}

fn read_task_dir(dir: &Path) -> Vec<TaskSnapshot> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<TaskSnapshot> = rd.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            Some(TaskSnapshot {
                id: v["id"].as_str().unwrap_or_default().to_string(),
                subject: v["subject"].as_str().unwrap_or_default().to_string(),
                status: v["status"].as_str().unwrap_or("pending").to_string(),
                blocked_by: v["blockedBy"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::DataRoot;
    use std::time::{Duration, SystemTime};

    fn fake_root() -> (tempfile::TempDir, DataRoot) {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("projects/-p/sess-1/subagents")).unwrap();
        std::fs::create_dir_all(d.path().join("tasks/sess-1")).unwrap();
        let root = DataRoot { tool: "claude-code", path: d.path().to_path_buf() };
        (d, root)
    }

    #[test]
    fn main_transcript_append_upserts_root_agent() {
        let (d, root) = fake_root();
        let p = d.path().join("projects/-p/sess-1.jsonl");
        std::fs::write(&p, concat!(
            r#"{"type":"ai-title","title":"Fix the tests"}"#, "\n",
            r#"{"type":"assistant","message":{"usage":{"cache_read_input_tokens":5000},"content":[{"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}]}}"#, "\n",
        )).unwrap();
        let mut e = Engine::new(vec![root]);
        let now = SystemTime::now();
        let evs = e.on_path_changed(&p, now);
        let snap = evs.iter().find_map(|ev| match ev { MapEvent::AgentUpserted(s) => Some(s), _ => None }).unwrap();
        assert_eq!(snap.id, "sess-1");
        assert_eq!(snap.description, "Fix the tests");
        assert_eq!(snap.context_tokens, 5000);
        assert_eq!(snap.current_activity, "Bash: cargo test");
        assert_eq!(snap.verification_runs, 1);
        assert_eq!(snap.status, "active");
        assert!(snap.parent_id.is_none());
    }

    #[test]
    fn subagent_meta_then_transcript_builds_tree() {
        let (d, root) = fake_root();
        let meta = d.path().join("projects/-p/sess-1/subagents/agent-a1.meta.json");
        std::fs::write(&meta, include_str!("../tests/fixtures/agent_meta.json")).unwrap();
        let mut e = Engine::new(vec![root]);
        let now = SystemTime::now();
        let evs = e.on_path_changed(&meta, now);
        let snap = evs.iter().find_map(|ev| match ev { MapEvent::AgentUpserted(s) => Some(s), _ => None }).unwrap();
        assert_eq!(snap.id, "sess-1/a1");
        assert_eq!(snap.agent_type, "general-purpose");
        assert_eq!(snap.parent_id.as_deref(), Some("sess-1/aff28")); // parentAgentId scoped to session
        let tr = d.path().join("projects/-p/sess-1/subagents/agent-a1.jsonl");
        std::fs::write(&tr, format!("{}\n", r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x.rs"}}]}}"#)).unwrap();
        let evs = e.on_path_changed(&tr, now);
        let snap = evs.iter().find_map(|ev| match ev { MapEvent::AgentUpserted(s) => Some(s), _ => None }).unwrap();
        assert_eq!(snap.files_touched, vec!["/x.rs"]);
    }

    #[test]
    fn task_file_change_emits_board() {
        let (d, root) = fake_root();
        let tf = d.path().join("tasks/sess-1/15.json");
        std::fs::write(&tf, include_str!("../tests/fixtures/task.json")).unwrap();
        let mut e = Engine::new(vec![root]);
        let evs = e.on_path_changed(&tf, SystemTime::now());
        match &evs[0] {
            MapEvent::TasksUpserted { session_id, tasks } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(tasks[0].subject, "PRA-1: schema");
                assert_eq!(tasks[0].status, "in_progress");
                assert_eq!(tasks[0].blocked_by, vec!["14"]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn initial_scan_stubs_old_sessions() {
        let (d, root) = fake_root();
        let p = d.path().join("projects/-p/sess-1.jsonl");
        std::fs::write(&p, "{}\n").unwrap();
        // make it look 8 days old
        let old = SystemTime::now() + Duration::from_secs(8 * 86_400); // "now" is 8d after mtime
        let mut e = Engine::new(vec![root]);
        let evs = e.initial_scan(old);
        let snap = evs.iter().find_map(|ev| match ev { MapEvent::AgentUpserted(s) => Some(s), _ => None }).unwrap();
        assert!(snap.stub);
        assert_eq!(snap.status, "stale");
        // drill-in lazily parses it
        let evs = e.parse_stub("sess-1", old);
        let snap = evs.iter().find_map(|ev| match ev { MapEvent::AgentUpserted(s) => Some(s), _ => None }).unwrap();
        assert!(!snap.stub);
    }

    #[test]
    fn removed_path_emits_agent_removed() {
        let (d, root) = fake_root();
        let p = d.path().join("projects/-p/sess-1.jsonl");
        std::fs::write(&p, "{}\n").unwrap();
        let mut e = Engine::new(vec![root]);
        e.on_path_changed(&p, SystemTime::now());
        let evs = e.on_path_removed(&p);
        assert!(matches!(&evs[0], MapEvent::AgentRemoved { id } if id == "sess-1"));
    }

    #[test]
    fn session_removal_forgets_subagent_tailer_state() {
        let (d, root) = fake_root();
        let p = d.path().join("projects/-p/sess-1.jsonl");
        std::fs::write(&p, "{}\n").unwrap();
        let sub = d.path().join("projects/-p/sess-1/subagents/agent-a1.jsonl");
        let first_line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/first.rs"}}]}}"#;
        std::fs::write(&sub, format!("{first_line}\n")).unwrap();
        let mut e = Engine::new(vec![root]);
        let now = SystemTime::now();
        e.on_path_changed(&p, now);
        e.on_path_changed(&sub, now); // consumes the first line, offset advances past it

        e.on_path_removed(&p); // should remove agents AND forget the subagent tailer offset

        // append a second line; if the offset was forgotten, re-reading starts from byte 0
        // and both lines (including the first) should be visible again.
        let second_line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/second.rs"}}]}}"#;
        std::fs::write(&sub, format!("{first_line}\n{second_line}\n")).unwrap();
        let evs = e.on_path_changed(&sub, now);
        let snap = evs.iter().find_map(|ev| match ev { MapEvent::AgentUpserted(s) => Some(s), _ => None }).unwrap();
        assert!(snap.files_touched.contains(&"/first.rs".to_string()), "{:?}", snap.files_touched);
        assert!(snap.files_touched.contains(&"/second.rs".to_string()), "{:?}", snap.files_touched);
    }

    #[test]
    fn task_file_deletion_updates_board() {
        let (d, root) = fake_root();
        let t1 = d.path().join("tasks/sess-1/15.json");
        let t2 = d.path().join("tasks/sess-1/16.json");
        std::fs::write(&t1, include_str!("../tests/fixtures/task.json")).unwrap();
        std::fs::write(&t2, r#"{"id":"16","subject":"PRA-2: other","description":"","status":"pending","blocks":[],"blockedBy":[]}"#).unwrap();
        let mut e = Engine::new(vec![root]);
        let evs = e.on_path_changed(&t1, SystemTime::now());
        match &evs[0] {
            MapEvent::TasksUpserted { tasks, .. } => assert_eq!(tasks.len(), 2),
            other => panic!("{other:?}"),
        }
        std::fs::remove_file(&t2).unwrap();
        let evs = e.on_path_removed(&t2);
        match &evs[0] {
            MapEvent::TasksUpserted { session_id, tasks } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(tasks.len(), 1);
                assert_eq!(tasks[0].id, "15");
            }
            other => panic!("{other:?}"),
        }
    }
}
