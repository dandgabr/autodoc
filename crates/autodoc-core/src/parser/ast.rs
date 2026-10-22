use crate::parser::complexity::calculate_text_complexity;
use crate::parser::{ExtractedEdge, ExtractedSymbol, ParseDiagnostic, ParseOutput};
use sha2::{Digest, Sha256};
use tree_sitter::{Language, Node, Parser};

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
    let content_sha256 = Sha256::digest(source_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    // If a local binding can shadow a top-level symbol, keep
    // name-only calls unresolved. This file-wide set is deliberately
    // conservative until lexical binding resolution is available.
    let shadowed_function_names = collect_shadowing_names(root, source_bytes);

    let mut cursor = root.walk();
    let mut stack = vec![(root, None::<String>)];

    while let Some((node, current_parent_fqsn)) = stack.pop() {
        let kind = node.kind();
        let mut new_parent_fqsn = current_parent_fqsn.clone();

        // Rust methods live under `impl_item`, which is a semantic scope but
        // is not itself a symbol in our current catalog. Include its receiver
        // type so same-named methods on different types remain distinct.
        if ext == "rs" && kind == "impl_item" {
            if let Some(receiver) = node
                .child_by_field_name("type")
                .and_then(|n| n.utf8_text(source_bytes).ok())
            {
                let scope = match &current_parent_fqsn {
                    Some(parent) => format!("{parent}::{receiver}"),
                    None => format!("{rel_path}::{receiver}"),
                };
                new_parent_fqsn = Some(scope);
            }
        }

        // 1. Detect Symbol Declarations
        if let Some((name, sym_kind, visibility)) = extract_node_symbol(node, source_bytes, ext) {
            let symbol_parent = if ext == "go" && kind == "method_declaration" {
                node.child_by_field_name("receiver")
                    .and_then(|receiver| receiver.utf8_text(source_bytes).ok())
                    .map(|receiver| {
                        format!(
                            "{}::{}",
                            new_parent_fqsn.as_deref().unwrap_or(rel_path),
                            normalize_receiver(receiver)
                        )
                    })
                    .or_else(|| new_parent_fqsn.clone())
            } else {
                new_parent_fqsn.clone()
            };
            let mut fqsn = match &symbol_parent {
                Some(parent) => format!("{}::{}", parent, name),
                None => format!("{}::{}", rel_path, name),
            };
            // Java permits overloads with the same name in one class. The
            // parameter list is stable declaration identity and also scopes
            // nested call sites beneath the method.
            if ext == "java" && kind == "method_declaration" {
                if let Some(parameters) = node
                    .child_by_field_name("parameters")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                {
                    let digest = Sha256::digest(parameters.as_bytes());
                    let suffix = digest
                        .iter()
                        .take(6)
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>();
                    fqsn.push_str(&format!("::<signature:{suffix}>"));
                }
            }

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
                if let Some((expression, callee, occurrence_kind)) =
                    extract_callee(node, source_bytes)
                {
                    let start = node.start_position().row as i32 + 1;
                    let end = node.end_position().row as i32 + 1;
                    let column_start = node.start_position().column as i32;
                    let column_end = node.end_position().column as i32;
                    edges.push(ExtractedEdge {
                        caller_fqsn: caller.clone(),
                        callee_name: callee,
                        callee_expression: expression,
                        edge_kind: "call".to_string(),
                        weight: 1.0,
                        occurrence_kind,
                        line_start: start,
                        line_end: end,
                        column_start,
                        column_end,
                        content_sha256: content_sha256.clone(),
                        method: "tree_sitter_ast".to_string(),
                        candidate_fqsns: Vec::new(),
                        resolution: "unresolved".to_string(),
                    });
                }
            }
        }

        // Push children to stack
        for child in node.children(&mut cursor) {
            stack.push((child, new_parent_fqsn.clone()));
        }
    }

    // The walk is preorder and can encounter calls before later declarations.
    // Resolve only after the complete semantic symbol set is known.
    for edge in &mut edges {
        let name = edge.callee_name.as_str();
        let candidates = find_lexical_candidates(&edge.caller_fqsn, name, &symbols);
        edge.candidate_fqsns = candidates
            .iter()
            .map(|symbol| symbol.fqsn.clone())
            .collect();
        let is_direct = edge.occurrence_kind == "direct_call";
        let is_shadowed = shadowed_function_names.contains(name);
        edge.resolution = if !is_direct || is_shadowed {
            "unresolved".into()
        } else if edge.candidate_fqsns.len() > 1 {
            "ambiguous".into()
        } else if edge.candidate_fqsns.len() == 1 {
            "resolved".into()
        } else {
            "unresolved".into()
        };
    }

    let has_syntax_errors = root.has_error();
    let callback_registration_seen = edges.iter().any(|edge| {
        ["addEventListener", "add_handler", "register_callback", "on"]
            .iter()
            .any(|marker| edge.callee_name == *marker)
    });
    let has_syntax_errors = has_syntax_errors || callback_registration_seen;
    Some(ParseOutput {
        symbols,
        edges,
        analysis_state: if has_syntax_errors {
            "partial"
        } else {
            "complete"
        }
        .into(),
        diagnostics: if has_syntax_errors {
            if root.has_error() {
                vec![ParseDiagnostic {
                    code: "SYNTAX_RECOVERY".into(),
                    message:
                        "Parser recovered from syntax errors; extracted facts may be incomplete."
                            .into(),
                }]
            } else {
                vec![ParseDiagnostic {
                    code: "CALLBACK_BINDING_UNSUPPORTED".into(),
                    message: "Callback registration was detected, but callback execution is not inferred as a direct call.".into(),
                }]
            }
        } else {
            Vec::new()
        },
    })
}

fn find_lexical_candidates<'a>(
    caller_fqsn: &str,
    name: &str,
    symbols: &'a [ExtractedSymbol],
) -> Vec<&'a ExtractedSymbol> {
    let caller_scope = caller_fqsn
        .split_once("::<signature:")
        .map_or(caller_fqsn, |(base, _)| base);
    let Some((mut scope, _)) = caller_scope.rsplit_once("::") else {
        return Vec::new();
    };
    let Some((root, _)) = caller_scope.split_once("::") else {
        return Vec::new();
    };

    loop {
        let candidates = symbols
            .iter()
            .filter(|symbol| {
                symbol.name == name
                    && symbol
                        .fqsn
                        .split_once("::<signature:")
                        .map_or(symbol.fqsn.as_str(), |(base, _)| base)
                        .rsplit_once("::")
                        .map(|(parent, _)| parent == scope)
                        .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        if !candidates.is_empty() {
            return candidates;
        }
        if scope == root {
            break;
        }
        let Some((parent, _)) = scope.rsplit_once("::") else {
            break;
        };
        scope = parent;
    }
    Vec::new()
}

fn extract_node_symbol(
    node: Node,
    source: &[u8],
    ext: &str,
) -> Option<(String, &'static str, String)> {
    let kind = node.kind();
    match ext {
        "ts" | "tsx" | "js" | "mjs" | "cjs" | "jsx" => match kind {
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
        },
        "py" | "pyi" => match kind {
            "function_definition" => {
                let name = get_child_text_by_field(node, "name", source)?;
                let vis = if name.starts_with('_') {
                    "private"
                } else {
                    "public"
                };
                Some((name, "function", vis.to_string()))
            }
            "class_definition" => {
                let name = get_child_text_by_field(node, "name", source)?;
                Some((name, "class", "public".to_string()))
            }
            _ => None,
        },
        "rs" => match kind {
            "function_item" => {
                let name = get_child_text_by_field(node, "name", source)?;
                let vis = if node.utf8_text(source).unwrap_or("").contains("pub ") {
                    "pub"
                } else {
                    "private"
                };
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
        },
        "go" => match kind {
            "function_declaration" | "method_declaration" => {
                let name = get_child_text_by_field(node, "name", source)?;
                let vis = if name
                    .chars()
                    .next()
                    .map(|c| c.is_uppercase())
                    .unwrap_or(false)
                {
                    "public"
                } else {
                    "private"
                };
                Some((name, "function", vis.to_string()))
            }
            "type_spec" => {
                let name = get_child_text_by_field(node, "name", source)?;
                Some((name, "type", "public".to_string()))
            }
            _ => None,
        },
        "java" => match kind {
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
        },
        "c" | "h" => match kind {
            "function_definition" => {
                let declarator = node.child_by_field_name("declarator")?;
                let name = declarator
                    .utf8_text(source)
                    .ok()?
                    .split('(')
                    .next()?
                    .trim()
                    .to_string();
                Some((name, "function", "public".to_string()))
            }
            "struct_specifier" => {
                let name = get_child_text_by_field(node, "name", source)?;
                Some((name, "struct", "public".to_string()))
            }
            _ => None,
        },
        _ => None,
    }
}

fn is_call_node(kind: &str) -> bool {
    matches!(kind, "call_expression" | "call" | "method_invocation")
}

fn extract_callee(node: Node, source: &[u8]) -> Option<(String, String, String)> {
    let function = node.child_by_field_name("function");
    let name_node = node.child_by_field_name("name");
    let object = node.child_by_field_name("object");
    let callee_node = function.or(name_node)?;
    let callee_name = if let Some(name) = name_node {
        name.utf8_text(source).ok()?.to_string()
    } else {
        let text = callee_node.utf8_text(source).ok()?;
        text.rsplit('.')
            .next()?
            .rsplit("::")
            .next()?
            .trim()
            .to_string()
    };
    let expression = if let Some(object) = object {
        format!("{}.{}", object.utf8_text(source).ok()?, callee_name)
    } else {
        callee_node.utf8_text(source).ok()?.to_string()
    };
    let occurrence_kind = if callee_node.kind() == "identifier" && object.is_none() {
        "direct_call"
    } else {
        "member_call"
    };
    Some((expression, callee_name, occurrence_kind.to_string()))
}

fn collect_shadowing_names(root: Node, source: &[u8]) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "variable_declarator" {
            if let Some(name) = node.child_by_field_name("name") {
                collect_binding_names(name, source, &mut names);
            }
        }
        let bindings = match node.kind() {
            "formal_parameters" | "parameters" | "parameter_list" => Some(node),
            "let_declaration" | "assignment" => node
                .child_by_field_name("pattern")
                .or_else(|| node.child_by_field_name("left")),
            "named_expression" => node.child_by_field_name("name"),
            "for_statement" => node.child_by_field_name("left"),
            "catch_clause" => node.child_by_field_name("parameter"),
            "short_var_declaration" => node.child_by_field_name("left"),
            _ => None,
        };
        if let Some(bindings) = bindings {
            collect_binding_names(bindings, source, &mut names);
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    names
}

fn collect_binding_names(node: Node, source: &[u8], names: &mut std::collections::HashSet<String>) {
    let mut stack = vec![node];
    while let Some(binding) = stack.pop() {
        if matches!(
            binding.kind(),
            "identifier" | "shorthand_property_identifier_pattern" | "identifier_pattern"
        ) {
            if let Ok(name) = binding.utf8_text(source) {
                names.insert(name.to_string());
            }
        }
        let mut cursor = binding.walk();
        stack.extend(binding.children(&mut cursor));
    }
}

fn get_child_text_by_field(node: Node, field: &str, source: &[u8]) -> Option<String> {
    node.child_by_field_name(field)
        .and_then(|n| n.utf8_text(source).ok())
        .map(|s| s.to_string())
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

fn normalize_receiver(receiver: &str) -> String {
    receiver
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split_whitespace()
        .last()
        .unwrap_or(receiver)
        .trim_start_matches('*')
        .to_string()
}
