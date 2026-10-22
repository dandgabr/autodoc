# ADR-003c: Polyglot AST Engine, Dynamic C4 and Realtime Architecture Analysis

> Mirrored from ai-memory `decisions/autodoc-polyglot-ast-and-realtime-engine.md`.

## Status: Accepted (verified through automated Rust and Vitest suites, 100% passing)

## Context
AutoDoc was enhanced to address static analysis shortcomings on polyglot codebases, lack of realtime protocol discovery, static C4 diagrams, and absence of structured documentation generation.

## Decisions

1. **Tree-Sitter & Heuristic Language Support**:
   - Configured Tree-sitter grammars cover TypeScript/TSX, JavaScript/JSX, Python, Rust, Go, Java, and C/header extensions. This list does not include C++.
   - Other languages use heuristic extraction where available; unsupported AST coverage is reported as partial rather than promised as complete.

2. **SQLite WAL High-Throughput Batch Ingestion**:
   - Atomic bulk transactions (`insert_batch_analysis`, `write_bulk_edges`) replacing unbatched channel insertions.
   - Zero-contention multithreaded scanning via Rayon threadpools streaming directly to SQLite WAL.

3. **Dynamic C4 Model Architecture Generation**:
   - Levels 1–3 dynamically discovered from `package.json` dependencies and SQLite graph symbols/call edges.
   - Enforced Mermaid C4 syntax (`C4Context`, `C4Container`, `C4Component`), WCAG 2.1 AA contrast, and entity sanitization.

4. **REST & Realtime Socket.io / WebRTC Contract Discovery**:
   - REST analyzer: Express, NestJS, FastAPI, Spring Boot endpoints.
   - Realtime analyzer: Socket.io events (`ClientToServerEvents`, `ServerToClientEvents`, `socket.on`, `socket.emit`) and WebRTC signaling (`webrtc:offer`, `webrtc:answer`, `webrtc:candidate`).

5. **Honesty Policy & Dead Code Detection**:
   - Compares declared typed interfaces against imperative socket calls to detect dead-declared events, undeclared/untyped events, and orphan function symbols.

6. **Documentation Synthesis**:
   - `autodoc_export_documentation` currently exports architecture/explanation reports, reference catalogs, and a getting-started tutorial when supported by the detected project. How-To guides are not currently generated.
