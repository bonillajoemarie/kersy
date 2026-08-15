use crate::adapter::ToolAdapter;
use std::path::{Component, Path, PathBuf};

pub struct ClaudeCodeAdapter;

impl ToolAdapter for ClaudeCodeAdapter {
    fn tool(&self) -> &'static str {
        "claude-code"
    }

    fn candidate_roots(&self, home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
        let mut v = Vec::new();
        if let Some(c) = env("CLAUDE_CONFIG_DIR") {
            v.push(PathBuf::from(c));
        }
        v.push(home.join(".claude"));
        let xdg = env("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        v.push(xdg.join("claude"));
        v
    }

    fn validate(&self, root: &Path) -> bool {
        let projects = root.join("projects");
        let Ok(rd) = std::fs::read_dir(&projects) else {
            return false;
        };
        rd.flatten().any(|proj| {
            std::fs::read_dir(proj.path())
                .map(|entries| {
                    entries.flatten().any(|e| {
                        e.path()
                            .extension()
                            .is_some_and(|x| x == "jsonl")
                            || e.path().is_dir()
                    })
                })
                .unwrap_or(false)
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum WatchedPath {
    MainTranscript {
        project: String,
        session: String,
    },
    SubagentTranscript {
        project: String,
        session: String,
        agent: String,
    },
    SubagentMeta {
        project: String,
        session: String,
        agent: String,
    },
    TaskFile {
        session: String,
    },
    Ignored,
}

pub fn classify(root: &Path, path: &Path) -> WatchedPath {
    let Ok(rel) = path.strip_prefix(root) else {
        return WatchedPath::Ignored;
    };
    let parts: Vec<&str> = rel
        .components()
        .filter_map(|c| {
            if let Component::Normal(s) = c {
                s.to_str()
            } else {
                None
            }
        })
        .collect();
    match parts.as_slice() {
        ["projects", project, file] if file.ends_with(".jsonl") => WatchedPath::MainTranscript {
            project: project.to_string(),
            session: file.trim_end_matches(".jsonl").to_string(),
        },
        ["projects", project, session, "subagents", file] => {
            let (name, is_meta) = match file.strip_suffix(".meta.json") {
                Some(n) => (n, true),
                None => match file.strip_suffix(".jsonl") {
                    Some(n) => (n, false),
                    None => return WatchedPath::Ignored,
                },
            };
            let Some(agent) = name.strip_prefix("agent-") else {
                return WatchedPath::Ignored;
            };
            let (project, session, agent) = (
                project.to_string(),
                session.to_string(),
                agent.to_string(),
            );
            if is_meta {
                WatchedPath::SubagentMeta {
                    project,
                    session,
                    agent,
                }
            } else {
                WatchedPath::SubagentTranscript {
                    project,
                    session,
                    agent,
                }
            }
        }
        ["tasks", session, file] if file.ends_with(".json") && !file.starts_with('.') => {
            WatchedPath::TaskFile {
                session: session.to_string(),
            }
        }
        _ => WatchedPath::Ignored,
    }
}

pub fn project_dir_to_path(slug: &str) -> String {
    slug.replace('-', "/").replace("//", "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::ToolAdapter;

    fn root() -> &'static Path {
        Path::new("/h/.claude")
    }

    #[test]
    fn classify_all_shapes() {
        assert_eq!(
            classify(root(), Path::new("/h/.claude/projects/-x-y/abc-123.jsonl")),
            WatchedPath::MainTranscript {
                project: "-x-y".into(),
                session: "abc-123".into()
            }
        );
        assert_eq!(
            classify(
                root(),
                Path::new("/h/.claude/projects/-x-y/abc-123/subagents/agent-0f.jsonl")
            ),
            WatchedPath::SubagentTranscript {
                project: "-x-y".into(),
                session: "abc-123".into(),
                agent: "0f".into()
            }
        );
        assert_eq!(
            classify(
                root(),
                Path::new("/h/.claude/projects/-x-y/abc-123/subagents/agent-0f.meta.json")
            ),
            WatchedPath::SubagentMeta {
                project: "-x-y".into(),
                session: "abc-123".into(),
                agent: "0f".into()
            }
        );
        assert_eq!(
            classify(root(), Path::new("/h/.claude/tasks/abc-123/7.json")),
            WatchedPath::TaskFile {
                session: "abc-123".into()
            }
        );
        assert_eq!(
            classify(root(), Path::new("/h/.claude/projects/-x-y/memory/MEMORY.md")),
            WatchedPath::Ignored
        );
        assert_eq!(
            classify(root(), Path::new("/h/.claude/tasks/abc-123/.lock")),
            WatchedPath::Ignored
        );
        assert_eq!(
            classify(
                Path::new("/other"),
                Path::new("/h/.claude/tasks/a/1.json")
            ),
            WatchedPath::Ignored
        );
    }

    #[test]
    fn adapter_validates_projects_with_jsonl() {
        let d = tempfile::tempdir().unwrap();
        let a = ClaudeCodeAdapter;
        assert!(!a.validate(d.path()));
        std::fs::create_dir_all(d.path().join("projects/-p")).unwrap();
        assert!(!a.validate(d.path()));
        std::fs::write(d.path().join("projects/-p/s.jsonl"), "").unwrap();
        assert!(a.validate(d.path()));
    }

    #[test]
    fn candidates_env_home_xdg() {
        let a = ClaudeCodeAdapter;
        let c = a.candidate_roots(Path::new("/home/u"), &|k| match k {
            "CLAUDE_CONFIG_DIR" => Some("/custom".into()),
            "XDG_CONFIG_HOME" => Some("/home/u/.config".into()),
            _ => None,
        });
        assert_eq!(
            c,
            vec![
                PathBuf::from("/custom"),
                PathBuf::from("/home/u/.claude"),
                PathBuf::from("/home/u/.config/claude"),
            ]
        );
    }

    #[test]
    fn slug_to_path() {
        assert_eq!(
            project_dir_to_path("-home-jmbonilla-workspace"),
            "/home/jmbonilla/workspace"
        );
    }
}
