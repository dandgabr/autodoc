# ADR-005: OpenAPI 3.1 Contract Compilation via Operation-Level Static Analysis

> Mirrored from ai-memory `decisions/autodoc-openapi-contract-compiler.md`.

## Status: Accepted (Pinned)

## Context
`autodoc_list_api_contracts` produced only a flat endpoint inventory (method + path + heuristic auth). To generate a complete OpenAPI (OAS 3.1) contract, endpoints needed parameters, request bodies, response schemas, security schemes and $ref components resolved from source code.

## Decision
1. **Operation contract extraction** (`analyzers/rest/operations.ts`): new module that infers per-operation contracts —
   - Path params from route templates (Express `:id`, FastAPI `{id}` via regex `(?::|\{)([a-zA-Z0-9_]+)(?:\}|(?=\/|$))`).
   - Query/header params from handler windows (`req.query.x`, FastAPI `Query()`, Gin `c.Query`, Spring `@RequestParam`, .NET `[FromQuery]`, Rails `params`).
   - Request bodies from Zod `z.object`, DTO/Pydantic refs, Go bind structs, `req.body` destructure fallback.
   - Responses from `res.status(n).json({...})` literal shapes, `response_model`, typed returns, with HTTP status map.
   - Security schemes (bearerAuth/apiKeyAuth/basicAuth/oauth2) from handler/middleware context.
2. **Handler windowing**: `extractHandlerWindow` narrows file body from the route declaration to the next route declaration to prevent parameter/response leakage across operations.
3. **File-scope validator fallback**: when the window only sees `const {a,b} = req.body`, a file-level `z.object` is preferred via `isRicherSchema` scoring (property count, then format/enum/optional richness) so optional fields and formats are not lost.
4. **OAS 3.1 compiler** (`analyzers/rest/openapi.ts`): combines RestAnalyzer + SchemaAnalyzer (models → `#/components/schemas`), path params merged (path wins over handler-inferred), operationIds deterministic, tags derived from path segments, unresolved $refs stubbed with inference provenance description, `x-source-file` per operation.
5. **New MCP tool** `autodoc_export_openapi` (repoPath/title/version/serverUrl/outputDir/includeTests) returning inline document or writing `openapi.json` to disk. Tool count is now 10.

## Consequences
- Complete OAS 3.1 contract: verified on fixture (2 ops: path params, Zod-derived body with email format + optional fields, 201/400 responses, bearerAuth).
- All 50 MCP tests pass; test suite updated for 10 tools.
- Limitations: literal-shape inference is regex-based (no full AST); complex nested bodies resolve as $ref stubs.
- Requires MCP server restart after `npm run build` (ADR-004 item 5).