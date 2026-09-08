use regex::Regex;
use std::sync::LazyLock;
use crate::parser::complexity::calculate_text_complexity;
use crate::parser::{ExtractedEdge, ExtractedSymbol, ParseOutput};

static RE_FUNC_GENERIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[ \t]*(?:(?:pub|public|private|protected|static|async|def|fn|func|function|sub|procedure)\s+)+([a-zA-Z_][a-zA-Z0-9_]*)").unwrap()
});

static RE_CLASS_GENERIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[ \t]*(?:(?:pub|public|private|protected|abstract|final)\s+)*(?:class|struct|interface|trait|enum|module|unit)\s+([a-zA-Z_][a-zA-Z0-9_]*)").unwrap()
});

static RE_SQL_TABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^[ \t]*CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)").unwrap()
});

static RE_ASM_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^([a-zA-Z_.][a-zA-Z0-9_.]*):").unwrap()
});

static RE_CALL_GENERIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(").unwrap()
});

pub fn parse_heuristics(content: &str, rel_path: &str, ext: &str) -> ParseOutput {
    let mut symbols = Vec::new();
    let mut edges = Vec::new();
    let lines: Vec<&str> = content.lines().collect();

    // 1. SQL DDL special handler
    if ext == "sql" {
        for (i, line) in lines.iter().enumerate() {
            if let Some(caps) = RE_SQL_TABLE.captures(line) {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                let line_num = (i + 1) as i32;
                let fqsn = format!("{}::{}", rel_path, name);
                symbols.push(ExtractedSymbol {
                    fqsn,
                    name: name.to_string(),
                    kind: "table".to_string(),
                    visibility: "public".to_string(),
                    line_start: line_num,
                    line_end: line_num + 5,
                    complexity: 1,
                    signature: line.trim().to_string(),
                    docstring: None,
                });
            }
        }
        return ParseOutput { symbols, edges };
    }

    // 2. Assembly special handler
    if matches!(ext, "s" | "asm") {
        for (i, line) in lines.iter().enumerate() {
            if let Some(caps) = RE_ASM_LABEL.captures(line) {
                let label = caps.get(1).map(|m| m.as_str()).unwrap_or("label");
                let line_num = (i + 1) as i32;
                let fqsn = format!("{}::{}", rel_path, label);
                symbols.push(ExtractedSymbol {
                    fqsn,
                    name: label.to_string(),
                    kind: "routine".to_string(),
                    visibility: "public".to_string(),
                    line_start: line_num,
                    line_end: line_num + 2,
                    complexity: 1,
                    signature: format!("{}:", label),
                    docstring: None,
                });
            }
        }
        return ParseOutput { symbols, edges };
    }

    // 3. Classes / Structs / Interfaces
    for (i, line) in lines.iter().enumerate() {
        if let Some(caps) = RE_CLASS_GENERIC.captures(line) {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("Class");
            let line_num = (i + 1) as i32;
            let fqsn = format!("{}::{}", rel_path, name);
            let kind = if line.contains("interface") {
                "interface"
            } else if line.contains("struct") {
                "struct"
            } else if line.contains("enum") {
                "enum"
            } else {
                "class"
            };

            symbols.push(ExtractedSymbol {
                fqsn,
                name: name.to_string(),
                kind: kind.to_string(),
                visibility: if line.contains("private") { "private".to_string() } else { "public".to_string() },
                line_start: line_num,
                line_end: (line_num + 15).min(lines.len() as i32),
                complexity: 1,
                signature: line.trim().to_string(),
                docstring: extract_docstring(&lines, i),
            });
        }
    }

    // 4. Functions / Methods
    let mut current_fn: Option<String> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(caps) = RE_FUNC_GENERIC.captures(line) {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("func");
            let line_num = (i + 1) as i32;
            let fqsn = format!("{}::{}", rel_path, name);
            current_fn = Some(fqsn.clone());

            let signature = line.trim().to_string();
            let docstring = extract_docstring(&lines, i);
            let complexity = calculate_text_complexity(line);

            symbols.push(ExtractedSymbol {
                fqsn: fqsn.clone(),
                name: name.to_string(),
                kind: "function".to_string(),
                visibility: if line.contains("private") { "private".to_string() } else { "public".to_string() },
                line_start: line_num,
                line_end: (line_num + 10).min(lines.len() as i32),
                complexity,
                signature,
                docstring,
            });
        }

        // Extract call references
        if let Some(ref caller) = current_fn {
            for caps in RE_CALL_GENERIC.captures_iter(line) {
                if let Some(callee) = caps.get(1) {
                    let callee_name = callee.as_str();
                    if callee_name != "if" && callee_name != "while" && callee_name != "for" && callee_name != "switch" && callee_name != "catch" {
                        edges.push(ExtractedEdge {
                            caller_fqsn: caller.clone(),
                            callee_name: callee_name.to_string(),
                            edge_kind: "call".to_string(),
                            weight: 1.0,
                        });
                    }
                }
            }
        }
    }

    ParseOutput { symbols, edges }
}

fn extract_docstring(lines: &[&str], line_idx: usize) -> Option<String> {
    if line_idx == 0 {
        return None;
    }
    let mut doc_lines = Vec::new();
    let mut idx = line_idx;
    while idx > 0 {
        idx -= 1;
        let line = lines[idx].trim();
        if line.starts_with("///") || line.starts_with("//") || line.starts_with('#') || line.starts_with('*') {
            doc_lines.push(line.trim_start_matches("///").trim_start_matches("//").trim_start_matches('#').trim_start_matches('*').trim());
        } else {
            break;
        }
    }
    if doc_lines.is_empty() {
        None
    } else {
        doc_lines.reverse();
        Some(doc_lines.join("\n"))
    }
}
