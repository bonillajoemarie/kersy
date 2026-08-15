use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Fact {
    ToolUse { tool: String, label: String, file: Option<String>, is_verification: bool },
    Usage { context_tokens: u64 },
    Title(String),
    ToolResult { stdout: String },
}

const VERIFICATION_MARKERS: &[&str] = &[
    "cargo test", "pytest", "pest", "phpunit", "npm test", "vitest", "npm run test",
    "ruff", "eslint", "pint", "tsc", "cargo clippy", "composer test", "npm run build",
    "cargo build", "php artisan test", "go test",
];

pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { return s.to_string(); }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

pub fn parse_line(line: &str) -> Vec<Fact> {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
    let mut facts = Vec::new();

    if v["type"] == "ai-title" {
        if let Some(t) = v["aiTitle"].as_str().or_else(|| v["title"].as_str()) {
            facts.push(Fact::Title(t.to_string()));
        }
    }
    if let Some(out) = v["toolUseResult"]["stdout"].as_str() {
        facts.push(Fact::ToolResult { stdout: clip(out, 200) });
    }
    if v["type"] == "assistant" {
        if let Some(tokens) = v["message"]["usage"]["cache_read_input_tokens"].as_u64() {
            facts.push(Fact::Usage { context_tokens: tokens });
        }
        if let Some(items) = v["message"]["content"].as_array() {
            for item in items.iter().filter(|i| i["type"] == "tool_use") {
                let tool = item["name"].as_str().unwrap_or("?").to_string();
                let input = &item["input"];
                let (label, file) = match tool.as_str() {
                    "Bash" => (input["command"].as_str().unwrap_or("").to_string(), None),
                    "Edit" | "Write" | "Read" | "NotebookEdit" => {
                        let p = input["file_path"].as_str().unwrap_or("").to_string();
                        (p.clone(), Some(p))
                    }
                    "Agent" => (input["description"].as_str().unwrap_or("").to_string(), None),
                    _ => (tool.clone(), None),
                };
                let is_verification = tool == "Bash"
                    && VERIFICATION_MARKERS.iter().any(|m| label.contains(m));
                facts.push(Fact::ToolUse { tool, label: clip(&label, 200), file, is_verification });
            }
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_tool_use_becomes_verification_fact() {
        let line = r#"{"type":"assistant","message":{"usage":{"cache_read_input_tokens":119322},"content":[{"type":"tool_use","name":"Bash","input":{"command":"cargo test --workspace"}}]}}"#;
        let facts = parse_line(line);
        assert!(facts.iter().any(|f| matches!(f, Fact::Usage { context_tokens: 119322 })));
        match facts.iter().find(|f| matches!(f, Fact::ToolUse { .. })).unwrap() {
            Fact::ToolUse { tool, label, is_verification, .. } => {
                assert_eq!(tool, "Bash");
                assert_eq!(label, "cargo test --workspace");
                assert!(is_verification);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn edit_tool_use_captures_file() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/a.rs"}}]}}"#;
        match &parse_line(line)[0] {
            Fact::ToolUse { file, is_verification, .. } => {
                assert_eq!(file.as_deref(), Some("/tmp/a.rs"));
                assert!(!is_verification);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn title_usage_result_and_garbage() {
        assert!(matches!(&parse_line(r#"{"type":"ai-title","title":"My Session"}"#)[0], Fact::Title(t) if t == "My Session"));
        assert!(matches!(&parse_line(r#"{"toolUseResult":{"stdout":"2 passed"}}"#)[0], Fact::ToolResult { stdout } if stdout == "2 passed"));
        assert!(parse_line("not json {{{").is_empty());
        assert!(parse_line(r#"{"type":"file-history-snapshot"}"#).is_empty());
    }

    #[test]
    fn title_parses_real_aititle_key() {
        let line = r#"{"type":"ai-title","aiTitle":"Real Session"}"#;
        match &parse_line(line)[0] {
            Fact::Title(t) => assert_eq!(t, "Real Session"),
            _ => panic!(),
        }
    }

    #[test]
    fn labels_are_clipped_to_200_chars() {
        let long = "x".repeat(500);
        let line = format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#);
        match &parse_line(&line)[0] {
            Fact::ToolUse { label, .. } => assert!(label.chars().count() <= 201), // 200 + '…'
            _ => panic!(),
        }
    }

    #[test]
    fn fixture_file_parses_without_panic() {
        let data = include_str!("../tests/fixtures/main_lines.jsonl");
        let mut has_title = false;
        let mut has_tool_result = false;
        for l in data.lines() {
            let facts = parse_line(l);
            for fact in &facts {
                if matches!(fact, Fact::Title(_)) {
                    has_title = true;
                }
                if matches!(fact, Fact::ToolResult { .. }) {
                    has_tool_result = true;
                }
            }
        }
        assert!(has_title, "fixture must contain at least one Title fact");
        assert!(has_tool_result, "fixture must contain at least one ToolResult fact");
    }
}
