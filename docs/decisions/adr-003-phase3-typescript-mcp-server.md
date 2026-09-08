# ADR-003: Phase 3 — TypeScript MCP Server, i18n & C4

> Mirrored from ai-memory `decisions/ADR-003-phase3-typescript-mcp-server.md`. Translated to English from the original Portuguese record.

## Status
Accepted - Consolidated with the User on 2026-09-08

## Context
After implementing Phase 2 (Rust Core Engine), the Phase 3 decisions were defined and aligned for the MCP server targeting AI Agents (OpenCode, Claude, Antigravity, Cursor, Cline).

---

## 1. Point 1: MCP Transport Modes (stdio vs SSE) & OpenCode Interoperability

1. **Default `stdio` transport**:
   - `stdout` strictly reserved for JSON-RPC 2.0; zero contamination with logs.
   - Diagnostics and warnings (`AUTODOC_W101`/`AUTODOC_W102`) go to `stderr` or `.autodoc/logs/autodoc.log` (POSIX 0600).
   - 100% compatibility with the JSON parser of OpenCode, Claude Desktop, Cursor, and Antigravity.
2. **`SSE` transport (optional)**:
   - Enabled via `--transport sse` or `AUTODOC_TRANSPORT=sse`.
   - Strict binding to loopback (`127.0.0.1`), ephemeral 256-bit Bearer Token printed to `stderr`, `Host`/`Origin` validation against DNS Rebinding and CSRF.
3. **`--print-opencode-config` flag** for a ready-made configuration snippet.

## 2. Point 2: Extensible Translation Layer (`@autodoc/i18n`)

1. **Extensible BCP 47 with fallback**: code is 100% `en-US`; native reports in `en-US`, `pt-BR`, `es-ES`; new languages via `.autodoc/locales/<bcp47>.json` without refactoring the engine.
2. **Syntactic shielding engine (`masker.ts`)**: code terms between backticks become inert tokens (`__AUTODOC_LITERAL_N__`) before translation; faithful post-unmasking.
3. **`locale?: string` parameter** standardized (default `en-US`).

## 3. Point 3: XSS Sanitization in Mermaid.js (LLM05)

1. **Banning of interactive directives**: `click`, `href`, `link`, `callback`, `call` are prohibited in generated diagrams.
2. **HTML entity escaping** (`<`, `>`, `"`, `'`, `&`) in all labels; normalization of parentheses/brackets.
3. **Dual format**: Mermaid.js (default) and Structurizr DSL via `format?`.

## 4. Point 4: MCP Tool Catalog, Resources, and Tests

1. **7 core tools**: `scan_repository`, `get_c4_diagram`, `get_symbol_contract`, `trace_data_flow`, `list_api_contracts`, `generate_adr`, `purge_cache`.
2. **Virtual resources**: `code://c4/{level}`, `code://symbols/{fqsn}`, `code://graph/callgraph`.
3. **Vitest suites**: `protocol`, `tools` (Zod schemas), `security` (path traversal), `xss`, `i18n`.

> Later expanded to 9, 10, and 11 tools (socket contracts, export_documentation, export_openapi, llm_status) — see ADR-003b/005/006.