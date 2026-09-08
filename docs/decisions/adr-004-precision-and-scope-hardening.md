# ADR-004: Precision Hardening, Test Suite Exclusion, and Subdocument Semantic Classification

> Mirrored from ai-memory `decisions/autodoc-precision-and-scope-hardening.md`.

## Status: Accepted (Pinned)

## Context
Following the first blind benchmark against the `butecogames` codebase, the analysis revealed three critical precision gaps in AutoDoc's catalog generation:
1. **Pollution of Contract Catalogs by Test Suites**: Unit and integration test files (`*.test.ts`, `*.spec.ts`, `__tests__/**`) contributed phantom endpoints and dynamic testing socket events (e.g. `room:abc`, `room:abc:spectators`).
2. **REST Mount Duplication & Path Collisions**: Prefix-nested subrouters with variable segment replacements resulted in phantom duplicated paths (e.g. `/api/users/users/:id/role` instead of cleanly mounted `/api/admin/users/:userId/role`).
3. **Mongoose Root Model vs. Subdocument Schema Conflation**: Nested embedded subdocuments (`Schema` instances embedded as arrays or fields within models, e.g. `matchPlayer`, `OptionData`, `CachedTrack`) were cataloged as independent root database collections, creating phantom collections (`rounddatas`, `viewers`).
4. **C4 Component Clutter**: Incidental shell/bash utility scripts (`database-backup.sh`) were rendered alongside core application backend components.
5. **Tutorial Workflow Accuracy**: Getting-started instructions defaulted to language-specific package managers rather than repository orchestration entrypoints (e.g. `make dev`).

## Decision
1. **Universal Test Suite Exclusion**:
   - Introduced `isTestPath(filePath)` in `analyzers/utils.ts` recognizing `*.test.*`, `*.spec.*`, `__tests__`, `fixtures`, `mocks`.
   - Added `includeTests: boolean` option (defaulting to `false`) across `RestAnalyzer`, `RealtimeAnalyzer`, `SchemaAnalyzer`, and `DiataxisGenerator`.
2. **Two-Pass Path Resolver**:
   - Implemented route mount disambiguation in `RestAnalyzer` preventing double prefixing when router mounts have nested variable substitutions.
3. **Mongoose Subdocument Semantic Classification**:
   - Analyzed Schema definitions vs `mongoose.model()` calls. Subdocument schemas are grouped into Section 2 ("Embedded Subdocuments & Value Objects") linking them to their parent models, preventing them from inflating the root collection count.
4. **C4 Noise Filtering**:
   - Filtered non-service utility scripts from component diagram synthesis.
5. **Process Lifecycle Awareness**:
   - Long-running Node.js stdio MCP server processes must be restarted after `npm run build` so that clients load the latest compiled `dist/index.js` bundle into RAM.

## Consequences
- REST endpoints on `butecogames` drop from 167 to 156 (exact elimination of phantom routes).
- Socket events drop from 220 to 218 with 0 test events (`room:abc` 100% eliminated).
- Root database models drop from 76 to 65, with 10 embedded subdocuments accurately identified and categorized.