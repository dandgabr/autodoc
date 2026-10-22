use autodoc_core::parser::parse_file;
use autodoc_core::{cache::StorageEngine, sanitizer::SanitizerEngine, scanner::RepositoryScanner};
use std::sync::Arc;
use tempfile::tempdir;

#[test]
fn reports_recovered_syntax_errors_as_partial_with_diagnostics() {
    let output = parse_file("function ok() { return 1; }\nfunction {", "bad.ts", "ts");
    assert_eq!(output.analysis_state, "partial");
    assert!(!output.diagnostics.is_empty());
}

#[test]
fn valid_tree_without_recognized_symbols_is_not_heuristically_invented() {
    let output = parse_file("const value = 1;", "value.ts", "ts");
    assert_eq!(output.analysis_state, "complete");
    assert!(output.symbols.is_empty());
}

#[test]
fn unsupported_language_heuristics_are_never_reported_as_complete() {
    let output = parse_file("public void run() { execute(); }", "src/Runner.cs", "cs");
    assert_eq!(output.analysis_state, "partial");
    assert!(output
        .diagnostics
        .iter()
        .any(|d| d.code == "AST_UNSUPPORTED"));
}

#[test]
fn parses_original_structure_but_persists_sanitized_signature_text() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("secret.ts"),
        "function connect(key = 'AKIA1234567890ABCDEF') { return key; }\n",
    )
    .unwrap();
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scan = RepositoryScanner::new(
        dir.path(),
        storage.clone(),
        Arc::new(SanitizerEngine::new()),
    )
    .scan_repository()
    .unwrap();
    let conn = storage.reader().unwrap();
    let signature: String = conn
        .query_row(
            "SELECT signature FROM generation_symbols WHERE scan_id=?1 AND name='connect'",
            [scan.scan_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!signature.contains("AKIA1234567890ABCDEF"));
    assert!(signature.contains("connect"));
}
