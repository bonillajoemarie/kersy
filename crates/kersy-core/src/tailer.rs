use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Default)]
struct TailState {
    offset: u64,
    partial: Vec<u8>,
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
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?; // only NEW bytes as bytes
        st.offset = len;

        let mut chunk = st.partial.clone();
        chunk.extend_from_slice(&buf);
        let mut lines: Vec<String> = Vec::new();
        let mut rest = chunk.as_slice();
        while let Some(i) = rest.iter().position(|&b| b == b'\n') {
            let line_bytes = &rest[..i];
            lines.push(String::from_utf8_lossy(line_bytes).into_owned());
            rest = &rest[i + 1..];
        }
        st.partial = rest.to_vec(); // buffer the tail (possibly mid-character)
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

    #[test]
    fn mid_character_flush_does_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        let mut t = Tailer::new();

        // "héllo 🚀\n" as bytes
        let full_line = "héllo 🚀\n";
        let full_bytes = full_line.as_bytes();

        // Split mid-character in the emoji (🚀 is 4 bytes in UTF-8: 0xF0 0x9F 0x9A 0x80)
        // "héllo 🚀" is 12 bytes, let's write only first 11 bytes (cutting the emoji mid-sequence)
        let split_at = 11; // This cuts the 4-byte emoji in half
        let first_part = &full_bytes[..split_at];
        let second_part = &full_bytes[split_at..];

        // Write first part (incomplete emoji at end)
        f.write_all(first_part).unwrap();
        f.flush().unwrap();

        // First read should return empty lines (no complete lines yet) and buffer the partial bytes
        let lines1 = t.read_new_lines(&p).unwrap();
        assert!(lines1.is_empty(), "Should have no complete lines when emoji is mid-sequence");

        // Write the rest of the line (completing the emoji)
        f.write_all(second_part).unwrap();
        f.flush().unwrap();

        // Second read should return the complete line with the full emoji intact
        let lines2 = t.read_new_lines(&p).unwrap();
        assert_eq!(lines2, vec!["héllo 🚀"], "Should recover complete line with emoji intact");
    }
}
