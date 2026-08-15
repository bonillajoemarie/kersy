use serde::Serialize;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

pub const RING_CAP: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventDto {
    pub label: String,
    pub tool: String,
    pub is_verification: bool,
    pub stdout: Option<String>,
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub id: String,
    pub session_id: String,
    pub project: String,
    pub tool: String,
    pub agent_type: String,
    pub description: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub current_activity: String,
    pub context_tokens: u64,
    pub files_touched: Vec<String>,
    pub verification_runs: u32,
    pub last_activity_ms: u64,
    pub stub: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub id: String,
    pub subject: String,
    pub status: String,
    pub blocked_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase", rename_all_fields = "camelCase")]
// Boxing AgentUpserted would change its serde wire shape (adds a layer of
// indirection the frontend's tagged-union decoder doesn't expect); these
// events are low-frequency (one per session/agent change), so the size
// difference is not a hot-path cost worth the wire-format churn.
#[allow(clippy::large_enum_variant)]
pub enum MapEvent {
    AgentUpserted(AgentSnapshot),
    TasksUpserted { session_id: String, tasks: Vec<TaskSnapshot> },
    AgentRemoved { id: String },
    DiscoveryDone { roots: Vec<String>, projects: u32, sessions: u32 },
}

#[derive(Debug)]
pub struct AgentState {
    pub id: String,
    pub session_id: String,
    pub project: String,
    pub tool: String,
    pub agent_type: String,
    pub description: String,
    pub parent_id: Option<String>,
    pub current_activity: String,
    pub context_tokens: u64,
    pub files_touched: BTreeSet<String>,
    pub verification_runs: u32,
    pub last_activity: SystemTime,
    pub stub: bool,
    pub title: Option<String>,
    pub recent: VecDeque<AgentEventDto>,
    pub seq: u64,
}

impl AgentState {
    pub fn new(id: String, session_id: String, project: String, tool: String) -> Self {
        Self {
            id,
            session_id,
            project,
            tool,
            agent_type: "session".into(),
            description: String::new(),
            parent_id: None,
            current_activity: String::new(),
            context_tokens: 0,
            files_touched: BTreeSet::new(),
            verification_runs: 0,
            last_activity: UNIX_EPOCH,
            stub: false,
            title: None,
            recent: VecDeque::with_capacity(RING_CAP),
            seq: 0,
        }
    }

    pub fn push_event(&mut self, mut e: AgentEventDto) {
        e.seq = self.seq;
        self.seq += 1;
        if e.is_verification {
            self.verification_runs += 1;
        }
        self.current_activity = format!("{}: {}", e.tool, e.label);
        if self.recent.len() == RING_CAP {
            self.recent.pop_front();
        }
        self.recent.push_back(e);
    }

    pub fn touch_file(&mut self, path: &str) {
        self.files_touched.insert(path.to_string());
    }

    pub fn snapshot(&self, status: &str) -> AgentSnapshot {
        AgentSnapshot {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            project: self.project.clone(),
            tool: self.tool.clone(),
            agent_type: self.agent_type.clone(),
            description: self.title.clone().unwrap_or_else(|| self.description.clone()),
            parent_id: self.parent_id.clone(),
            status: status.to_string(),
            current_activity: self.current_activity.clone(),
            context_tokens: self.context_tokens,
            files_touched: self.files_touched.iter().cloned().collect(),
            verification_runs: self.verification_runs,
            last_activity_ms: self
                .last_activity
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            stub: self.stub,
        }
    }
}

#[derive(Default)]
pub struct World {
    pub agents: HashMap<String, AgentState>,
    pub tasks: HashMap<String, Vec<TaskSnapshot>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_caps_at_50() {
        let mut a = AgentState::new("s1".into(), "s1".into(), "-p".into(), "claude-code".into());
        for i in 0..60 {
            a.push_event(AgentEventDto {
                label: format!("cmd {i}"),
                tool: "Bash".into(),
                is_verification: false,
                stdout: None,
                seq: i,
            });
        }
        assert_eq!(a.recent.len(), 50);
        assert_eq!(a.recent.front().unwrap().seq, 10); // oldest evicted
    }

    #[test]
    fn map_event_serializes_tagged_camel_case() {
        let ev = MapEvent::TasksUpserted {
            session_id: "s".into(),
            tasks: vec![],
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(
            json.contains(r#""event":"tasksUpserted""#),
            "{}",
            json
        );
        assert!(
            json.contains(r#""sessionId":"s""#),
            "{}",
            json
        );
    }

    #[test]
    fn verification_and_files_accumulate() {
        let mut a = AgentState::new("s1".into(), "s1".into(), "-p".into(), "claude-code".into());
        a.push_event(AgentEventDto {
            label: "cargo test".into(),
            tool: "Bash".into(),
            is_verification: true,
            stdout: None,
            seq: 0,
        });
        a.touch_file("/a/b.rs");
        a.touch_file("/a/b.rs"); // dedup
        assert_eq!(a.verification_runs, 1);
        assert_eq!(a.files_touched.len(), 1);
    }
}
