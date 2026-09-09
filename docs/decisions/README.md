# Architecture Decision Records

This directory is the on-repository mirror of the project's full decision tree, synchronized with the long-term memory store (ai-memory). Each ADR records the context, decision and consequences of a fundamental architectural choice.

## Index

| ADR | Title | Status | Key artifacts |
|---|---|---|---|
| [ADR-001](./adr-001-hybrid-deterministic-semantic-architecture.md) | Hybrid Deterministic and Semantic Architecture | Accepted (foundational) | `crates/autodoc-core`, `packages/autodoc-mcp` |
| [ADR-002](./adr-002-phase2-rust-core-decision-tree.md) | Phase 2 — Rust Core Engine Decision Tree (PII, SQLite WAL, Token Budgeting, Test Pyramid) | Accepted | `crates/autodoc-core` |
| [ADR-003](./adr-003-phase3-typescript-mcp-server.md) | Phase 3 — TypeScript MCP Server (7 tools, i18n, C4, XSS hardening) | Accepted | `packages/autodoc-mcp` |
| [ADR-003b](./adr-003b-agnostic-discovery-engine.md) | Agnostic Workspace, Multi-Container and Modular Architecture Discovery Engine | Accepted (pinned) | `analyzers/workspace.ts`, `analyzers/containers.ts` |
| [ADR-003c](./adr-003c-polyglot-ast-and-realtime-engine.md) | Polyglot AST Engine, Dynamic C4 and Realtime Analysis | Accepted (pinned) | `analyzers/*`, `diagrams/renderer.ts` |
| [ADR-004](./adr-004-precision-and-scope-hardening.md) | Precision Hardening, Test Suite Exclusion and Subdocument Classification | Accepted (pinned) | `analyzers/utils.ts`, all analyzers |
| [ADR-005](./adr-005-openapi-contract-compiler.md) | OpenAPI 3.1 Contract Compilation via Operation-Level Static Analysis | Accepted (pinned) | `analyzers/rest/operations.ts`, `analyzers/rest/openapi.ts` |
| [ADR-006](./adr-006-local-llm-enrichment.md) | Local LLM Enrichment with Hardware-Adaptive Model Profiles | Accepted (pinned) | `llm/*`, `analyzers/llm-candidate-filter.ts` |

## Reading order

1. ADR-001 — why the system is deterministic-first with semantic layers.
2. ADR-002/003 — phase decisions for the Rust core and the MCP server.
3. ADR-003b/003c — discovery engine and polyglot/realtime evolution.
4. ADR-004 — precision lessons from the first external benchmark.
5. ADR-005 — the OpenAPI contract compiler (regex-based operation extraction).
6. ADR-006 — the local LLM enrichment layer (≤5 GB) that augments (never replaces) the deterministic pipeline; includes GPU backend priority (CUDA > ROCm > SYCL > Vulkan > Metal > CPU) and licensing posture for the node-llama-cpp/llama.cpp/GGUF stack.

## Governance

Decisions are recorded in ai-memory (`decisions/` namespace, pinned) and mirrored here. When a new ADR is accepted, both stores must be updated in the same change set. Related operational checklists live in `docs/how-to/`, and reference material in `docs/reference/`.