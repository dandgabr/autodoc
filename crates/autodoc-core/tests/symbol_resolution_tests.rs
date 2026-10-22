use autodoc_core::{
    cache::StorageEngine,
    parser::{parse_file, ExtractedEdge},
};
use tempfile::tempdir;

#[test]
fn ambiguous_unqualified_callee_is_not_promoted_to_a_call_edge() {
    let dir = tempdir().unwrap();
    let storage = StorageEngine::new(dir.path()).unwrap();
    let file = storage
        .insert_file("src/calls.rs", 1, 1, "x", "rs")
        .unwrap();
    storage
        .insert_symbol(
            file,
            "caller",
            "caller",
            "function",
            "pub",
            1,
            1,
            1,
            "fn caller()",
            None,
        )
        .unwrap();
    storage
        .insert_symbol(
            file,
            "left::save",
            "save",
            "function",
            "pub",
            2,
            2,
            1,
            "fn save()",
            None,
        )
        .unwrap();
    storage
        .insert_symbol(
            file,
            "right::save",
            "save",
            "function",
            "pub",
            3,
            3,
            1,
            "fn save()",
            None,
        )
        .unwrap();

    let count = storage
        .bulk_resolve_edges(vec![ExtractedEdge {
            caller_fqsn: "caller".into(),
            callee_name: "save".into(),
            edge_kind: "calls".into(),
            weight: 1.0,
            callee_expression: "save".into(),
            occurrence_kind: "direct_call".into(),
            line_start: 1,
            line_end: 1,
            column_start: 0,
            column_end: 4,
            content_sha256: String::new(),
            method: "test".into(),
            candidate_fqsns: vec![],
            resolution: "unresolved".into(),
        }])
        .unwrap();
    assert_eq!(count, 0, "ambiguous names must remain unresolved");
    let conn = storage.reader().unwrap();
    let edges: i64 = conn
        .query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))
        .unwrap();
    assert_eq!(edges, 0);
}

#[test]
fn unique_name_in_another_file_is_not_promoted_to_a_call_edge() {
    let dir = tempdir().unwrap();
    let storage = StorageEngine::new(dir.path()).unwrap();
    let caller_file = storage
        .insert_file("src/caller.rs", 1, 1, "x", "rs")
        .unwrap();
    let target_file = storage
        .insert_file("src/other.rs", 1, 1, "y", "rs")
        .unwrap();
    storage
        .insert_symbol(
            caller_file,
            "caller",
            "caller",
            "function",
            "pub",
            1,
            1,
            1,
            "fn caller()",
            None,
        )
        .unwrap();
    storage
        .insert_symbol(
            target_file,
            "other::save",
            "save",
            "function",
            "pub",
            1,
            1,
            1,
            "fn save()",
            None,
        )
        .unwrap();
    let count = storage
        .bulk_resolve_edges(vec![ExtractedEdge {
            caller_fqsn: "caller".into(),
            callee_name: "save".into(),
            edge_kind: "calls".into(),
            weight: 1.0,
            callee_expression: "save".into(),
            occurrence_kind: "direct_call".into(),
            line_start: 1,
            line_end: 1,
            column_start: 0,
            column_end: 4,
            content_sha256: String::new(),
            method: "test".into(),
            candidate_fqsns: vec![],
            resolution: "unresolved".into(),
        }])
        .unwrap();
    assert_eq!(
        count, 0,
        "cross-file name matches lack import or binding evidence"
    );
}

#[test]
fn shadowed_function_variable_and_member_calls_are_not_confirmed_edges() {
    let parsed = parse_file(
        "function save() {}\nfunction caller() { const save = () => {}; save(); obj.save(); }\nfunction parameterShadow(save) { save(); }",
        "src/calls.js",
        "js",
    );

    assert!(
        !parsed.edges.is_empty(),
        "unsupported call occurrences must remain visible as relationships"
    );
    assert!(
        parsed
            .edges
            .iter()
            .all(|edge| edge.resolution != "resolved"),
        "shadowed and receiver calls need binding evidence"
    );

    let rust = parse_file(
        "fn save() {} fn caller(save: fn()) { save(); } fn closure_shadow() { let save = || {}; save(); }",
        "src/calls.rs",
        "rs",
    );
    assert!(
        rust.edges.iter().all(|edge| edge.resolution != "resolved"),
        "Rust parameters and local bindings must not resolve by name alone"
    );

    let python = parse_file(
        "def save():\n    pass\ndef caller():\n    save = lambda: None\n    save()\n",
        "src/calls.py",
        "py",
    );
    assert!(
        python
            .edges
            .iter()
            .all(|edge| edge.resolution != "resolved"),
        "Python local assignments must not resolve by name alone"
    );

    let destructuring = parse_file(
        "function save() {}\nfunction caller() { const { save } = obj; save(); }\nfunction caught() { try {} catch (save) { save(); } }",
        "src/destructure.js",
        "js",
    );
    assert!(
        destructuring
            .edges
            .iter()
            .all(|edge| edge.resolution != "resolved"),
        "destructured bindings must not resolve by name alone"
    );

    let python_loop = parse_file(
        "def save():\n    pass\ndef caller(values):\n    for save in values:\n        save()\n",
        "src/loop.py",
        "py",
    );
    assert!(
        python_loop
            .edges
            .iter()
            .all(|edge| edge.resolution != "resolved"),
        "Python loop targets must not resolve by name alone"
    );
}

#[test]
fn direct_unique_calls_keep_semantic_target_and_callsite_evidence() {
    let parsed = parse_file(
        "function save() {}\nfunction caller() { save(); }",
        "src/calls.js",
        "js",
    );
    let call = parsed
        .edges
        .iter()
        .find(|edge| edge.callee_name == "save")
        .unwrap();

    assert_eq!(call.resolution, "resolved");
    assert_eq!(call.candidate_fqsns, vec!["src/calls.js::save"]);
    assert_eq!(call.callee_expression, "save");
    assert_eq!(call.occurrence_kind, "direct_call");
    assert_eq!(call.method, "tree_sitter_ast");
    assert_eq!((call.line_start, call.line_end), (2, 2));
    assert_eq!(call.content_sha256.len(), 64);
}

#[test]
fn ambiguous_member_shadowed_and_external_calls_remain_visible_unresolved() {
    let parsed = parse_file(
        "function save() {}\nfunction save(x) {}\nfunction caller(save) { save(); obj.save(); missing(); }",
        "src/calls.js",
        "js",
    );

    let by_expression = parsed
        .edges
        .iter()
        .map(|edge| (edge.callee_expression.as_str(), edge))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(by_expression.len(), 3);
    assert_eq!(
        by_expression["save"].resolution, "unresolved",
        "parameter binding prevents name-only resolution"
    );
    assert_eq!(
        by_expression["obj.save"].resolution, "unresolved",
        "receiver type is not proven"
    );
    assert_eq!(
        by_expression["missing"].resolution, "unresolved",
        "external/import target is not proven"
    );
}

#[test]
fn actual_self_recursion_resolves_but_comments_and_strings_are_not_occurrences() {
    let parsed = parse_file(
        "function walk() { walk(); }\n// walk()\nconst text = \"walk()\";",
        "src/recursive.js",
        "js",
    );
    assert_eq!(parsed.edges.len(), 1);
    assert_eq!(parsed.edges[0].resolution, "resolved");
    assert_eq!(
        parsed.edges[0].caller_fqsn,
        parsed.edges[0].candidate_fqsns[0]
    );
}

#[test]
fn callback_registration_does_not_infer_callback_execution() {
    let parsed = parse_file(
        "function handler() {}\nfunction setup(button) { button.addEventListener('click', handler); }",
        "src/callback.js",
        "js",
    );
    assert!(
        !parsed
            .edges
            .iter()
            .any(|edge| edge.callee_name == "handler"),
        "callback references are not synchronous call edges"
    );
    assert!(
        parsed.analysis_state == "partial"
            || parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "CALLBACK_BINDING_UNSUPPORTED")
    );
}

#[test]
fn java_overloads_are_ambiguous_and_receiver_methods_stay_candidates() {
    let java = parse_file(
        "class Store { void save() {} void save(String value) {} void run() { save(); } }",
        "src/Store.java",
        "java",
    );
    let save = java
        .edges
        .iter()
        .find(|edge| edge.callee_name == "save")
        .unwrap();
    assert_eq!(save.resolution, "ambiguous");
    assert_eq!(save.candidate_fqsns.len(), 2);

    let rust = parse_file(
        "struct Store {} impl Store { fn save(&self) {} } fn run(store: Store) { store.save(); }",
        "src/store.rs",
        "rs",
    );
    let receiver = rust
        .edges
        .iter()
        .find(|edge| edge.callee_name == "save")
        .unwrap();
    assert_eq!(receiver.resolution, "unresolved");
    assert_eq!(receiver.occurrence_kind, "member_call");
}

#[test]
fn go_receiver_method_is_not_resolved_by_method_name_alone() {
    let go = parse_file(
        "package store\ntype Store struct {}\nfunc (s *Store) Save() {}\nfunc run(s *Store) { s.Save() }",
        "src/store.go",
        "go",
    );
    let receiver = go
        .edges
        .iter()
        .find(|edge| edge.callee_name == "Save")
        .unwrap();
    assert_eq!(receiver.resolution, "unresolved");
    assert!(receiver.callee_expression.contains("Save"));
}

#[test]
fn nested_declaration_is_not_resolved_from_an_unrelated_lexical_scope() {
    let parsed = parse_file(
        "function owner() { function local() {} } function unrelated() { local(); }",
        "src/scopes.js",
        "js",
    );
    let call = parsed
        .edges
        .iter()
        .find(|edge| edge.callee_name == "local")
        .unwrap();
    assert_eq!(call.resolution, "unresolved");
}
