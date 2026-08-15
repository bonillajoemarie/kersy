use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

const OUTSIDE_PROJECTS: &str = "Path is outside your projects";

/// Canonicalizes `path` and confirms it falls under one of the (already
/// canonicalized) discovered project roots. This is the only path-safety
/// gate for `list_dir`/`run_prompt` — canonicalize resolves `..` components
/// and symlinks alike, so a symlink inside a project that points outside it
/// is rejected exactly like a literal `../` escape would be.
// TOCTOU note: the path is canonicalized here but used (read_dir'd, or set as a spawned
// process's cwd) slightly later. Accepted: single-user desktop app, no privilege boundary
// crossed between the check and the use.
fn guard_path(path: &Path, project_paths: &[PathBuf]) -> Result<PathBuf, String> {
    let real = path
        .canonicalize()
        .map_err(|_| OUTSIDE_PROJECTS.to_string())?;
    if project_paths.iter().any(|p| real.starts_with(p)) {
        Ok(real)
    } else {
        Err(OUTSIDE_PROJECTS.to_string())
    }
}

/// Builds the arg vector for the `claude` CLI invocation. The `--` separator is load-bearing:
/// `-p` is a boolean flag to the CLI's arg parser (commander.js), and without a separator a
/// prompt beginning with `-` (e.g. `--dangerously-skip-permissions ...`) would be parsed as a
/// flag instead of the positional prompt string.
fn prompt_args(prompt: &str) -> [&str; 3] {
    ["-p", "--", prompt]
}

/// Lists a directory's immediate children, dirs-first then case-insensitive
/// by name. `path` must canonicalize to somewhere under a discovered
/// project's real path.
pub fn list_dir(path: &Path, project_paths: &[PathBuf]) -> Result<Vec<DirEntry>, String> {
    let real = guard_path(path, project_paths)?;
    let rd = std::fs::read_dir(&real).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let is_dir = e.file_type().ok()?.is_dir();
            Some(DirEntry { name, is_dir })
        })
        .collect();
    entries.sort_by_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(entries)
}

/// Spawns a detached, headless `claude -p -- <prompt>` in `project_path`
/// (validated the same way as `list_dir`), redirecting stdout/stderr to a
/// timestamped log file under the app's data dir. No shell is invoked —
/// args go through `Command::arg`, never string interpolation.
pub fn run_prompt(project_path: &Path, prompt: &str, project_paths: &[PathBuf]) -> Result<(), String> {
    let real = guard_path(project_path, project_paths)?;

    let log_dir = dirs::data_dir()
        .ok_or_else(|| "no data dir".to_string())?
        .join("kersy")
        .join("prompt-logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let log_path = log_dir.join(format!("{millis}.log"));
    let stdout_log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let stderr_log = stdout_log.try_clone().map_err(|e| e.to_string())?;

    std::process::Command::new("claude")
        .args(prompt_args(prompt))
        .current_dir(&real)
        .stdout(stdout_log)
        .stderr(stderr_log)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

static CLI_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Whether the `claude` CLI is on PATH, probed once with `claude --version`
/// and cached for the process lifetime.
pub fn cli_available() -> bool {
    *CLI_AVAILABLE.get_or_init(|| {
        std::process::Command::new("claude")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(p: &Path) -> PathBuf {
        p.canonicalize().unwrap()
    }

    #[test]
    fn inside_project_path_passes() {
        let project = tempfile::tempdir().unwrap();
        let sub = project.path().join("src");
        std::fs::create_dir(&sub).unwrap();
        let roots = vec![canon(project.path())];
        let result = guard_path(&sub, &roots);
        assert_eq!(result.unwrap(), canon(&sub));
    }

    #[test]
    fn dot_dot_escape_is_rejected() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("secret")).unwrap();
        let roots = vec![canon(project.path())];
        // project/../<outside-tempdir-name>/secret resolves (via canonicalize)
        // to a real path outside the project root.
        let escape = project
            .path()
            .join("..")
            .join(outside.path().file_name().unwrap())
            .join("secret");
        let result = guard_path(&escape, &roots);
        assert_eq!(result.unwrap_err(), OUTSIDE_PROJECTS);
    }

    #[test]
    fn unrelated_path_is_rejected() {
        let project = tempfile::tempdir().unwrap();
        let unrelated = tempfile::tempdir().unwrap();
        let roots = vec![canon(project.path())];
        let result = guard_path(unrelated.path(), &roots);
        assert_eq!(result.unwrap_err(), OUTSIDE_PROJECTS);
    }

    #[test]
    #[cfg(unix)]
    fn symlink_escaping_outside_is_rejected() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = project.path().join("escape");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let roots = vec![canon(project.path())];
        let result = guard_path(&link, &roots);
        assert_eq!(result.unwrap_err(), OUTSIDE_PROJECTS);
    }

    #[test]
    fn list_dir_sorts_dirs_first_case_insensitive() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir(project.path().join("Zebra")).unwrap();
        std::fs::create_dir(project.path().join("apple")).unwrap();
        std::fs::write(project.path().join("Banana"), "").unwrap();
        std::fs::write(project.path().join("cat"), "").unwrap();
        let roots = vec![canon(project.path())];
        let entries = list_dir(project.path(), &roots).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["apple", "Zebra", "Banana", "cat"]);
        assert!(entries[0].is_dir && entries[1].is_dir);
        assert!(!entries[2].is_dir && !entries[3].is_dir);
    }

    #[test]
    fn list_dir_rejects_path_outside_projects() {
        let project = tempfile::tempdir().unwrap();
        let unrelated = tempfile::tempdir().unwrap();
        let roots = vec![canon(project.path())];
        let err = list_dir(unrelated.path(), &roots).unwrap_err();
        assert_eq!(err, OUTSIDE_PROJECTS);
    }

    #[test]
    fn prompt_args_separator_prevents_flag_injection() {
        // The claude CLI's `-p` is a boolean flag (commander.js); without a `--` separator a
        // prompt starting with `-` is parsed as a flag rather than the positional prompt
        // (empirically: `claude -p --version` prints the version instead of prompting).
        assert_eq!(prompt_args("--version"), ["-p", "--", "--version"]);
    }

    #[test]
    fn run_prompt_rejects_path_outside_projects() {
        let project = tempfile::tempdir().unwrap();
        let unrelated = tempfile::tempdir().unwrap();
        let roots = vec![canon(project.path())];
        let err = run_prompt(unrelated.path(), "hello", &roots).unwrap_err();
        assert_eq!(err, OUTSIDE_PROJECTS);
    }
}
