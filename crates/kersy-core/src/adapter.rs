use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct DataRoot {
    pub tool: &'static str,
    pub path: PathBuf,
}

pub trait ToolAdapter: Send + Sync {
    fn tool(&self) -> &'static str;
    fn candidate_roots(
        &self,
        home: &Path,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Vec<PathBuf>;
    fn validate(&self, root: &Path) -> bool;
}

pub fn discover(
    adapters: &[Box<dyn ToolAdapter>],
    home: &Path,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<DataRoot> {
    let mut out = Vec::new();
    for a in adapters {
        for c in a.candidate_roots(home, env) {
            if c.is_dir() && a.validate(&c) && !out.iter().any(|r: &DataRoot| r.path == c) {
                out.push(DataRoot {
                    tool: a.tool(),
                    path: c,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Stub;

    impl ToolAdapter for Stub {
        fn tool(&self) -> &'static str {
            "stub"
        }

        fn candidate_roots(
            &self,
            home: &Path,
            env: &dyn Fn(&str) -> Option<String>,
        ) -> Vec<PathBuf> {
            let mut v = vec![];
            if let Some(o) = env("STUB_DIR") {
                v.push(PathBuf::from(o));
            }
            v.push(home.join(".stub"));
            v
        }

        fn validate(&self, root: &Path) -> bool {
            root.join("marker").exists()
        }
    }

    #[test]
    fn discover_returns_only_valid_existing_roots_env_first() {
        let home = tempfile::tempdir().unwrap();
        let envdir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".stub")).unwrap();
        std::fs::write(home.path().join(".stub/marker"), "").unwrap();
        std::fs::write(envdir.path().join("marker"), "").unwrap();
        let env_path = envdir.path().to_path_buf();
        let adapters: Vec<Box<dyn ToolAdapter>> = vec![Box::new(Stub)];
        let roots = discover(&adapters, home.path(), &|k| {
            (k == "STUB_DIR").then(|| env_path.to_string_lossy().to_string())
        });
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].path, env_path); // env candidate probed first
        assert_eq!(roots[0].tool, "stub");
    }

    #[test]
    fn discover_skips_missing_and_invalid() {
        let home = tempfile::tempdir().unwrap(); // .stub doesn't exist
        let adapters: Vec<Box<dyn ToolAdapter>> = vec![Box::new(Stub)];
        assert!(discover(&adapters, home.path(), &|_| None).is_empty());
    }
}
