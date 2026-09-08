use tree_sitter::{Language, Node, Parser};
use crate::parser::complexity::calculate_text_complexity;
use crate::parser::{ExtractedEdge, ExtractedSymbol, ParseOutput};

pub fn parse_ast(content: &str, rel_path: &str, ext: &str) -> Option<ParseOutput> {
    let language: Language = match ext {
        "ts" => Language::from(tree_sitter_typescript::LANGUAGE_TYPESCRIPT),
        "tsx" => Language::from(tree_sitter_typescript::LANGUAGE_TSX),
        "js" | "mjs" | "cjs" | "jsx" => Language::from(tree_sitter_javascript::LANGUAGE),
        "py" | "pyi" => Language::from(tree_sitter_python::LANGUAGE),
        "rs" => Language::from(tree_sitter_rust::LANGUAGE),
        "go" => Language::from(tree_sitter_go::LANGUAGE),
        "java" => Language::from(tree_sitter_java::LANGUAGE),
        "c" | "h" => Language::from(tree_sitter_c::LANGUAGE),
        _ => return None,
    };

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return None;
    }

    let tree = parser.parse(content, None)?;
    let root = tree.root_node();

    let mut symbols = Vec::new();
    let mut edges = Vec::new();
    let source_bytes = content.as_bytes();

    let mut cursor = root.walk();
    let mut stack = vec![(root, None::<String>)];

    while let Some((node, current_parent_fqsn)) = stack.pop() {
        let kind = node.kind();
        let mut new_parent_fqsn = current_parent_fqsn.clone();

        // 1. Detect Symbol Declarations
        if let Some((name, sym_kind, visibility)) = extract_node_symbol(node, source_bytes, ext) {
            let fqsn = match &current_parent_fqsn {
                Some(parent) => format!("{}::{}", parent, name),
                None => format!("{}::{}", rel_path, name),
            };

            let start_point = node.start_position();
            let end_point = node.end_position();
            let line_start = (start_point.row + 1) as i32;
            let line_end = (end_point.row + 1) as i32;

            let node_text = node.utf8_text(source_bytes).unwrap_or("");
            let first_line = node_text.lines().next().unwrap_or("").trim().to_string();
            let complexity = calculate_text_complexity(node_text);

            symbols.push(ExtractedSymbol {
                fqsn: fqsn.clone(),
                name,
                kind: sym_kind.to_string(),
                visibility,
                line_start,
                line_end,
                complexity,
                signature: first_line,
                docstring: None,
            });

            new_parent_fqsn = Some(fqsn);
        }

        // 2. Detect Call Sites for Edges
        if is_call_node(kind) {
            if let Some(caller) = &current_parent_fqsn {
                if let Some(callee) = extract_callee_name(node, source_bytes) {
                    edges.push(ExtractedEdge {
                        caller_fqsn: caller.clone(),
                        callee_name: callee,
                        edge_kind: "call".to_string(),
                        weight: 1.0,
                    });
                }
            }
        }

        // Push children to stack
        for child in node.children(&mut cursor) {
            stack.push((child, new_parent_fqsn.clone()));
        }
    }

    Some(ParseOutput { symbols, edges })
}

fn extract_node_symbol(node: Node, source: &[u8], ext: &str) -> Option<(String, &'static str, String)> {
    let kind = node.kind();
    match ext {
        "ts" | "tsx" | "js" | "mjs" | "cjs" | "jsx" => {
            match kind {
                "function_declaration" | "method_definition" => {
                    let name = get_child_text_by_field(node, "name", source)
                        .or_else(|| get_first_child_of_kind(node, "identifier", source))?;
                    Some((name, "function", "public".to_string()))
                }
                "class_declaration" => {
                    let name = get_child_text_by_field(node, "name", source)
                        .or_else(|| get_first_child_of_kind(node, "type_identifier", source))?;
                    Some((name, "class", "public".to_string()))
                }
                "interface_declaration" => {
                    let name = get_child_text_by_field(node, "name", source)
                        .or_else(|| get_first_child_of_kind(node, "type_identifier", source))?;
                    Some((name, "interface", "public".to_string()))
                }
                "enum_declaration" => {
                    let name = get_child_text_by_field(node, "name", source)
                        .or_else(|| get_first_child_of_kind(node, "identifier", source))?;
                    Some((name, "enum", "public".to_string()))
                }
                _ => None,
            }
        }
        "py" | "pyi" => {
            match kind {
                "function_definition" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    let vis = if name.starts_with('_') { "private" } else { "public" };
                    Some((name, "function", vis.to_string()))
                }
                "class_definition" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "class", "public".to_string()))
                }
                _ => None,
            }
        }
        "rs" => {
            match kind {
                "function_item" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    let vis = if node.utf8_text(source).unwrap_or("").contains("pub ") { "pub" } else { "private" };
                    Some((name, "function", vis.to_string()))
                }
                "struct_item" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "struct", "public".to_string()))
                }
                "enum_item" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "enum", "public".to_string()))
                }
                "trait_item" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "trait", "public".to_string()))
                }
                _ => None,
            }
        }
        "go" => {
            match kind {
                "function_declaration" | "method_declaration" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    let vis = if name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) { "public" } else { "private" };
                    Some((name, "function", vis.to_string()))
                }
                "type_spec" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "type", "public".to_string()))
                }
                _ => None,
            }
        }
        "java" => {
            match kind {
                "method_declaration" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "method", "public".to_string()))
                }
                "class_declaration" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "class", "public".to_string()))
                }
                "interface_declaration" => {
                    let name = get_child_text_by_field(node, "interface", source)?;
                    Some((name, "interface", "public".to_string()))
                }
                _ => None,
            }
        }
        "c" | "h" => {
            match kind {
                "function_definition" => {
                    let declarator = node.child_by_field_name("declarator")?;
                    let name = declarator.utf8_text(source).ok()?.split('(').next()?.trim().to_string();
                    Some((name, "function", "public".to_string()))
                }
                "struct_specifier" => {
                    let name = get_child_text_by_field(node, "name", source)?;
                    Some((name, "struct", "public".to_string()))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn is_call_node(kind: &str) -> bool {
    matches!(kind, "call_expression" | "call" | "method_invocation")
}

fn extract_callee_name(node: Node, source: &[u8]) -> Option<String> {
    if let Some(function_node) = node.child_by_field_name("function") {
        let text = function_node.utf8_text(source).ok()?;
        return Some(text.split('.').next_back().unwrap_or(text).to_string());
    }
    if let Some(name_node) = node.child_by_field_name("name") {
        return name_node.utf8_text(source).ok().map(|s| s.to_string());
    }
    None
}

fn get_child_text_by_field(node: Node, field: &str, source: &[u8]) -> Option<String> {
    node.child_by_field_name(field).and_then(|n| n.utf8_text(source).ok()).map(|s| s.to_string())
}

fn get_first_child_of_kind(node: Node, kind: &str, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == kind {
            return child.utf8_text(source).ok().map(|s| s.to_string());
        }
    }
    None
}
