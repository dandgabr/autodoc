# Explanation: Why Rust and TypeScript?

This document outlines the architectural trade-offs that led to pairing Rust and TypeScript in AutoDoc.

---

## The Core Challenge

Codebase mapping involves two conflicting requirements:
1. **High-Throughput Parsing and Graph Computation**: Scanning 100,000 files, evaluating AST trees, computing PageRank centrality, and filtering regex patterns over gigabytes of source text. Running this entirely in a single-threaded JavaScript event loop creates noticeable latency and triggers V8 heap crashes on large repositories.
2. **Rapid MCP Protocol Integration**: The Model Context Protocol (MCP) evolves quickly, with its official reference SDK maintained in TypeScript. AI agent harnesses (Claude Desktop, Cursor, Cline, OpenCode) rely primarily on Node.js-based stdio transports.

---

## Architectural Decision

AutoDoc divides responsibilities across a strict boundary:

| Responsibility | Language | Justification |
| :--- | :--- | :--- |
| Stdio JSON-RPC 2.0 Transport | TypeScript | Native MCP SDK compliance and easy configuration in agent harnesses. |
| Zod Parameter Validation | TypeScript | Expressive schema definitions with automatic error messages. |
| Parallel Directory Traversal | Rust (Rayon) | Work-stealing threadpool scales across all available CPU cores. |
| String Interning & Memory Limit | Rust (Lasso) | Deduplicates identifiers, keeping peak RSS under 100MB for 1M+ LOC. |
| Graph Algorithms & Centrality | Rust (Petgraph)| Zero-cost abstraction graph primitives with contiguous memory layouts. |
| Secrets & PII Scrubbing | Rust (Regex) | Aho-Corasick linear-time scanning immune to Regular Expression Denial of Service (ReDoS). |
| Graph Persistence | Rust (SQLite WAL) | Fast local embedded storage with memory-mapped I/O and zero-copy queries. |

---

## FFI Boundary Safety: Intercepting Native Panics

A native crash in a Node-API addon terminates the host Node.js process without emitting a stack trace. 

To ensure stability across the stdio transport, AutoDoc wraps all exported Rust methods in `std::panic::catch_unwind`:

```rust
let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    // Rust engine computation
}));

match result {
    Ok(val) => Ok(val),
    Err(cause) => {
        // Translates panic into structured AUTODOC_E401 error
        Err(napi::Error::from_reason(format!("AUTODOC_E401: Internal engine panic: {:?}", cause)))
    }
}
```

If an internal invariant fails inside the Rust engine, the MCP server stays alive and reports a clean error message back to the AI agent.
