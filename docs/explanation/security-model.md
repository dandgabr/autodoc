# Explanation: Security and Defense-in-Depth Model

This document describes how AutoDoc mitigates security risks when analyzing untrusted or third-party code repositories.

---

## Threat Landscape

When an AI agent connects to a repository, three primary attack vectors emerge:
1. **Indirect Prompt Injection (OWASP LLM01)**: Malicious instructions embedded in docstrings, commit messages, or comments designed to hijack the agent's goal.
2. **Output Handling / XSS (OWASP LLM05)**: Injected JavaScript or HTML entities in Mermaid diagrams executing in the user's IDE or web preview.
3. **Denial of Wallet / Context Exhaustion (OWASP LLM10)**: Huge symbol tables or cyclic graphs overflowing the model's token limit, increasing cost and degrading reasoning.

---

## 1. Mitigation against Indirect Prompt Injection (LLM01)

AutoDoc isolates all scanned source snippets inside semantic defense tags before returning data to the AI agent:

```html
<untrusted_code_context origin="ast_scanner" path="crates/core/src/scanner.rs" symbol="scan_repository">
pub fn scan_repository(path: &Path) -> Result<ScanReport, AutoDocError>
</untrusted_code_context>
```

The native Rust engine escapes any nested `</untrusted_code_context>` sequence inside the source text into `&lt;/untrusted_code_context&gt;`. This prevents an attacker from escaping the untrusted context container.

---

## 2. Output Hardening and Zero-XSS Guarantee (LLM05)

When rendering Mermaid.js flowcharts or Structurizr DSL scripts, the `DiagramRenderer` applies three levels of sanitization:
1. **HTML Entity Encoding**: Transforms `<`, `>`, `"`, `'`, and `&` into standard XML entities (`&lt;`, `&gt;`, `&quot;`, `&#39;`, `&amp;`).
2. **Identifier Normalization**: Node IDs are restricted to the character set `[a-zA-Z0-9_]`.
3. **URI Protocol Blocking**: Blocks any link or callback containing `javascript:`, `data:`, `vbscript:`, or `onerror`.

---

## 3. Defense against Context Window Exhaustion (LLM10)

To prevent massive repositories from overflowing agent token limits:
- **Centrality-Based Pruning**: AutoDoc computes PageRank over the internal call graph and selects the top 35 architectural hub nodes by default.
- **Auxiliary Grouping**: Secondary nodes are clustered into aggregated summary boxes (e.g. `"+ 42 Auxiliary Components"`).
- **AST Skeletonization**: `autodoc_get_symbol_contract` strips implementation blocks by default, returning only class and method signatures.
