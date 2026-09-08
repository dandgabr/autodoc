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
    pub callee_name: String,
    pub edge_kind: String,
    pub weight: f64,
}

#[derive(Debug, Default, Clone)]
pub struct ParseOutput {
    pub symbols: Vec<ExtractedSymbol>,
    pub edges: Vec<ExtractedEdge>,
}

/// Dispatches parsing across Tier 1 AST engine and Tier 2/3 Heuristic engines.
pub fn parse_file(content: &str, rel_path: &str, ext: &str) -> ParseOutput {
    // 1. Try Tier 1 Deep Tree-Sitter AST parsing
    if let Some(ast_output) = ast::parse_ast(content, rel_path, ext) {
        if !ast_output.symbols.is_empty() {
            return ast_output;
        }
    }

    // 2. Fallback to Universal Heuristic Parser for Tier 2/3 and syntax recovery
    heuristics::parse_heuristics(content, rel_path, ext)
}
