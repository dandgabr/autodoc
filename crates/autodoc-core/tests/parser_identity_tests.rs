use autodoc_core::parser::parse_file;

#[test]
fn methods_with_the_same_name_keep_distinct_container_identity() {
    let source = r#"
class Alpha {
  save() { return this.write(); }
}
class Beta {
  save() { return this.write(); }
}
"#;
    let parsed = parse_file(source, "src/example.ts", "ts");
    let mut methods: Vec<_> = parsed
        .symbols
        .iter()
        .filter(|s| s.name == "save")
        .map(|s| s.fqsn.as_str())
        .collect();
    methods.sort_unstable();
    assert_eq!(
        methods,
        vec!["src/example.ts::Alpha::save", "src/example.ts::Beta::save"]
    );
}

#[test]
fn impl_methods_have_receiver_scope_in_identity() {
    let source = r#"
struct Alpha;
struct Beta;
impl Alpha { fn save(&self) {} }
impl Beta { fn save(&self) {} }
"#;
    let parsed = parse_file(source, "src/example.rs", "rs");
    let mut methods: Vec<_> = parsed
        .symbols
        .iter()
        .filter(|s| s.name == "save")
        .map(|s| s.fqsn.as_str())
        .collect();
    methods.sort_unstable();
    assert_eq!(
        methods,
        vec!["src/example.rs::Alpha::save", "src/example.rs::Beta::save"]
    );
}

#[test]
fn go_methods_have_receiver_type_in_identity() {
    let source = r#"
type Alpha struct{}
type Beta struct{}
func (a *Alpha) save() {}
func (b *Beta) save() {}
"#;
    let parsed = parse_file(source, "src/example.go", "go");
    let mut methods: Vec<_> = parsed
        .symbols
        .iter()
        .filter(|s| s.name == "save")
        .map(|s| s.fqsn.as_str())
        .collect();
    methods.sort_unstable();
    assert_eq!(
        methods,
        vec!["src/example.go::Alpha::save", "src/example.go::Beta::save"]
    );
}

#[test]
fn java_overloads_have_distinct_signature_identity() {
    let parsed = parse_file(
        "class Store { void save(int value) {} void save(String value) {} }",
        "src/Store.java",
        "java",
    );
    let methods: Vec<_> = parsed.symbols.iter().filter(|s| s.name == "save").collect();
    assert_eq!(methods.len(), 2);
    assert_ne!(methods[0].fqsn, methods[1].fqsn);
    assert!(methods.iter().all(|method| method.fqsn.contains("::<signature:")));
}

#[test]
fn heuristic_fallback_does_not_turn_comments_or_declarations_into_calls() {
    let source = r#"
function declared(value) {
  // pretendCall();
  return value;
}
"#;
    let parsed = parse_file(source, "src/example.unsupported", "unsupported");
    assert!(
        parsed.edges.is_empty(),
        "heuristic text matches are not call-site evidence: {:?}",
        parsed.edges
    );
}

#[test]
fn ast_edges_are_derived_only_from_call_nodes() {
    let source = r#"
function declared() {}
function caller() {
  // declared();
  declared();
}
"#;
    let parsed = parse_file(source, "src/example.js", "js");
    assert_eq!(parsed.edges.len(), 1);
    assert_eq!(parsed.edges[0].caller_fqsn, "src/example.js::caller");
    assert_eq!(parsed.edges[0].callee_name, "declared");
}
