use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Default)]
struct TailState {
    offset: u64,
    partial: String,
}

#[derive(Default)]
pub struct Tailer {
    files: HashMap<PathBuf, TailState>,
}

impl Tailer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn forget(&mut self, path: &Path) {
        self.files.remove(path);
    }

    pub fn read_new_lines(&mut self, path: &Path) -> std::io::Result<Vec<String>> {
        let st = self.files.entry(path.to_path_buf()).or_default();
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        if len < st.offset {
            st.offset = 0;
            st.partial.clear();
        }   // truncated/rewritten
        f.seek(SeekFrom::Start(st.offset))?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)?; // only NEW bytes
        st.offset = len;

        let mut chunk = std::mem::take(&mut st.partial);
        chunk.push_str(&buf);
        let mut lines: Vec<String> = Vec::new();
        let mut rest = chunk.as_str();
        while let Some(i) = rest.find('\n') {
            lines.push(rest[..i].to_string());
            rest = &rest[i + 1..];
        }
        st.partial = rest.to_string(); // buffer the tail
        Ok(lines.into_iter().filter(|l| !l.is_empty()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn incremental_reads_and_partial_line_buffering() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        let mut t = Tailer::new();

        write!(f, "{{\"a\":1}}\n{{\"b\":").unwrap();
        f.flush().unwrap();
        assert_eq!(t.read_new_lines(&p).unwrap(), vec!["{\"a\":1}"]); // partial held back

        write!(f, "2}}\n").unwrap();
        f.flush().unwrap();
        assert_eq!(t.read_new_lines(&p).unwrap(), vec!["{\"b\":2}"]); // completed now

        assert!(t.read_new_lines(&p).unwrap().is_empty()); // nothing new
    }

    #[test]
    fn truncation_resets_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        std::fs::write(&p, "one\ntwo\n").unwrap();
        let mut t = Tailer::new();
        assert_eq!(t.read_new_lines(&p).unwrap().len(), 2);
        std::fs::write(&p, "new\n").unwrap(); // shorter file
        assert_eq!(t.read_new_lines(&p).unwrap(), vec!["new"]);
    }
}
