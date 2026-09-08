# Honesty Policy: Quirks & Dead Code Report

Generated at: `2026-09-08T16:26:28.170Z`

Total Divergences Detected: **20**

## 1. Dead Declared Socket Events
- **`webrtc:offer`** (`packages/autodoc-mcp/src/analyzers/realtime/index.ts`): Declared in TypeScript socket interface (BIDIRECTIONAL) but no active emit or handler found in codebase.
- **`webrtc:answer`** (`packages/autodoc-mcp/src/analyzers/realtime/index.ts`): Declared in TypeScript socket interface (BIDIRECTIONAL) but no active emit or handler found in codebase.
- **`webrtc:candidate`** (`packages/autodoc-mcp/src/analyzers/realtime/index.ts`): Declared in TypeScript socket interface (BIDIRECTIONAL) but no active emit or handler found in codebase.
- **`webrtc:ice-candidate`** (`packages/autodoc-mcp/src/analyzers/realtime/index.ts`): Declared in TypeScript socket interface (BIDIRECTIONAL) but no active emit or handler found in codebase.

## 2. Undeclared Socket Events
- **`eventName`** (`packages/autodoc-mcp/src/analyzers/realtime/index.ts`): Emitted or listened with string literal 'eventName', but not declared in typed Socket.io interfaces.

## 3. Orphan Function Symbols
- **`wrap_untrusted_code`** (`crates/autodoc-core/src/errors.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`unmask`** (`crates/autodoc-core/src/errors.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`mask`** (`crates/autodoc-core/src/errors.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`sanitize`** (`packages/autodoc-mcp/tests/e2e.test.ts`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`secret_scanner_mut`** (`packages/autodoc-mcp/tests/e2e.test.ts`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`pii_registry_mut`** (`packages/autodoc-mcp/tests/e2e.test.ts`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`new`** (`packages/autodoc-mcp/tests/e2e.test.ts`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`default`** (`packages/autodoc-mcp/tests/e2e.test.ts`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`test_without_rowid_and_covering_indexes`** (`packages/autodoc-mcp/src/logger.ts`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`test_sqlite_wal_concurrent_stress`** (`packages/autodoc-mcp/src/logger.ts`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`test_scanner_end_to_end_symbol_extraction`** (`crates/autodoc-core/tests/parser_tests.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`test_sql_and_heuristics_parsing`** (`crates/autodoc-core/tests/parser_tests.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`test_python_ast_parsing`** (`crates/autodoc-core/tests/parser_tests.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`test_rust_ast_parsing`** (`crates/autodoc-core/tests/parser_tests.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.
- **`test_typescript_ast_parsing`** (`crates/autodoc-core/tests/parser_tests.rs`): Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.