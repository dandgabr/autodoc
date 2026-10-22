pub mod ast;
pub mod complexity;
pub mod heuristics;

#[derive(Debug, Clone)]
pub struct ExtractedSymbol {
    pub fqsn: String,
    pub name: String,
    pub kind: String,
    pub visibility: String,
    pub line_start: i32,
    pub line_end: i32,
    pub complexity: i32,
    pub signature: String,
    pub docstring: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ExtractedEdge {
    pub caller_fqsn: String,
    /// Backwards-compatible short name; never use this field alone as identity.
    pub callee_name: String,
    /// Complete callee expression as it appeared at the callsite.
    pub callee_expression: String,
    pub edge_kind: String,
    pub weight: f64,
    pub occurrence_kind: String,
    pub line_start: i32,
    pub line_end: i32,
    pub column_start: i32,
    pub column_end: i32,
    pub content_sha256: String,
    pub method: String,
    /// Semantic candidates. These are FQSNs until the cache assigns IDs.
    pub candidate_fqsns: Vec<String>,
    /// `resolved`, `ambiguous`, or `unresolved`.
    pub resolution: String,
}

#[derive(Debug, Default, Clone)]
pub struct ParseOutput {
    pub symbols: Vec<ExtractedSymbol>,
    pub edges: Vec<ExtractedEdge>,
    pub analysis_state: String,
    pub diagnostics: Vec<ParseDiagnostic>,
}

#[derive(Debug, Clone)]
pub struct ParseDiagnostic {
    pub code: String,
    pub message: String,
}

/// Dispatches parsing across Tier 1 AST engine and Tier 2/3 Heuristic engines.
pub fn parse_file(content: &str, rel_path: &str, ext: &str) -> ParseOutput {
    // 1. Try Tier 1 Deep Tree-Sitter AST parsing
    if let Some(ast_output) = ast::parse_ast(content, rel_path, ext) {
        return ast_output;
    }

    // 2. Fallback to Universal Heuristic Parser for Tier 2/3 and syntax recovery
    let mut output = heuristics::parse_heuristics(content, rel_path, ext);
    // Heuristic extraction cannot establish complete coverage for languages
    // without an AST grammar. Keep its useful candidates, but label them partial.
    if !matches!(ext, "sql" | "s" | "asm") {
        output.analysis_state = "partial".into();
        output.diagnostics.push(ParseDiagnostic {
            code: "AST_UNSUPPORTED".into(),
            message: format!(
                "No AST parser is available for .{ext}; heuristic facts may be incomplete."
            ),
        });
    }
    output
}
