# Reference: MCP Tools Specification

This document provides technical specifications for the eleven Model Context Protocol (MCP) tools implemented in `@autodoc/mcp`.

Tools marked with "LLM-aware" accept optional `llm_enrich` (boolean) and `model_profile` (`small` | `mid` | `large`) arguments. With the local model configured (see [Local LLM Enrichment](../how-to/local-llm-enrichment.md)), these tools enhance their deterministic output; without a model, or on LLM failure, they return identical regex-only results with `llmEnriched: false`.

---

## 1. `autodoc_scan_repository`

Discovers repository structure, polyglot languages, manifests, and LOC metrics using multi-threaded Rayon scanning and SQLite WAL caching.

### Parameters
| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `repoPath` | string | No | Current working dir | Absolute path to the repository root. |
| `deepScan` | boolean | No | `false` | When true, parses full AST and call graph edges. |
| `enablePiiScrubbing` | boolean | No | `true` | When true, filters secrets and PII from file content. |

### Response Schema
```json
{
  "status": "SUCCESS",
  "repositoryPath": "/path/to/repo",
  "scannedFiles": 35,
  "totalLoc": 3253,
  "languages": ["rs", "ts"],
  "engine": "NAPI-RS / Rayon",
  "piiScrubbed": true,
  "cacheLocation": "/path/to/repo/.autodoc/cache.db"
}
```

---

## 2. `autodoc_get_c4_diagram`

Generates interactive, XSS-free C4 diagrams in Mermaid.js or Structurizr DSL.

### Parameters
| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `level` | integer | No | `2` | C4 zoom level: `1` (Context), `2` (Container), `3` (Component), `4` (Code). |
| `format` | string | No | `"mermaid"` | Output format: `"mermaid"` or `"structurizr"`. |
| `max_nodes` | integer | No | `35` | Maximum visible nodes to prevent context window overflow. |
| `locale` | string | No | `"en-US"` | BCP 47 locale tag (`en-US`, `pt-BR`, `es-ES`). |
| `sanitizeOutput` | boolean | No | `true` | Neutralizes script tags, event handlers, and javascript URIs. |
| `llm_enrich` | boolean | No | `false` | LLM-aware: refines node descriptions from graph evidence. |
| `model_profile` | string | No | `auto` | Model profile for LLM enrichment: `small`, `mid`, `large`, or `auto`. |

The response includes `llmEnriched` (boolean) and, when enrichment was applied, a `model` object (`profile`, `modelId`, `contextTokens`, `device`).

---

## 3. `autodoc_get_symbol_contract`

Extracts deterministic AST symbol signatures enclosed in semantic prompt defense boundaries (`<untrusted_code_context>`).

### Parameters
| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `symbolName` | string | Yes | Fully Qualified Symbol Name (FQSN). |
| `filePath` | string | No | Relative or absolute path to source file. |
| `include_body` | boolean | No | When false, skeletonizes body to preserve token budget. |

---

## 4. `autodoc_trace_data_flow`

Traces taint data flows from external entrypoints (sources) through sanitizers to persistence or network sinks.

### Parameters
| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sourceEntrypoint` | string | Yes | Name of entrypoint function or API controller. |
| `targetSink` | string | No | Destination sink (e.g. database table or external API). |
| `maxDepth` | integer | No | Maximum call graph search depth (1-20, default: 5). |

---

## 5. `autodoc_list_api_contracts`

Inventories inbound and outbound service endpoints spanning 30 years of enterprise protocols.

### Parameters
| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `protocolFilter` | string | No | `"ALL"`, `"REST"`, `"SOAP"`, `"GRPC"`, `"GRAPHQL"`, or `"CORBA"`. |
| `limit` | integer | No | Pagination limit (1-100, default: 50). |
| `cursor` | string | No | Cursor for paginated traversal. |
| `include_tests` | boolean | No | `false` | Whether to include test suites and mock files in discovery. |

---

## 6. `autodoc_generate_adr`

Synthesizes an Architecture Decision Record in Markdown format following the MADR structure.

### Parameters
| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `title` | string | Yes | Title of the architectural decision. |
| `decision` | string | Yes | Accepted decision statement. |
| `context` | string | No | Problem background and drivers. |
| `locale` | string | No | Target locale for document headers (default: `en-US`). |
| `llm_enrich` | boolean | No | `false` | LLM-aware: synthesizes elaborate Context/Decision/Consequences from the seed; falls back to the deterministic template when the LLM is unavailable. |
| `model_profile` | string | No | `auto` | Model profile for LLM enrichment. |

When enrichment succeeds, the response includes `llmEnriched: true` and a `model` object, and the ADR body contains a `## Consequences` section derived from the seed evidence.

---

## 7. `autodoc_list_socket_contracts`

Discovers Socket.io events, WebSocket listeners/emitters, typed payload interfaces, and WebRTC signaling contracts across client and server source files.

### Parameters
| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `directionFilter` | string | No | `"ALL"` | Event direction: `"ALL"`, `"CLIENT_TO_SERVER"`, `"SERVER_TO_CLIENT"`, or `"BIDIRECTIONAL"`. |
| `limit` | integer | No | `50` | Pagination limit (1-200). |
| `cursor` | string | No | - | Cursor for paginated traversal. |

### Response Schema
```json
{
  "protocolsSupported": ["SOCKET_IO", "WEBRTC", "WEBSOCKET"],
  "directionFilter": "ALL",
  "contracts": [
    {
      "eventName": "webrtc:offer",
      "direction": "BIDIRECTIONAL",
      "payloadType": "RTCSessionDescriptionInit | RTCIceCandidateInit",
      "sourceFile": "packages/autodoc-mcp/src/analyzers/realtime/index.ts",
      "protocol": "WEBRTC",
      "isTypedContract": true
    }
  ],
  "total": 1
}
```

---

## 8. `autodoc_export_documentation`

Synthesizes living technical documentation structured according to the Diátaxis documentation framework (Tutorials, How-To Guides, Technical Reference, and Architectural Explanation) directly from the SQLite graph and exports it to the filesystem.

### Parameters
| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `outputDir` | string | No | `"./docs"` | Directory path where Diátaxis markdown files will be written. |
| `includeSourceRef` | boolean | No | `true` | Include source code references and line numbers in markdown files. |

### Response Schema
```json
{
  "status": "SUCCESS",
  "targetDirectory": "./docs",
  "filesGenerated": 7,
  "files": [
    "architecture/system-overview.md",
    "architecture/quirks-and-dead-code.md",
    "reference/http-endpoints.md",
    "reference/socket-events.md",
    "reference/data-models.md",
    "tutorials/getting-started.md",
    "how-to/add-new-module.md"
  ],
  "message": "Diátaxis living documentation successfully synthesized into ./docs"
}
```

---

## 9. `autodoc_purge_cache`

Truncates and vacuums local SQLite cache files to comply with GDPR/LGPD Right to be Forgotten.

### Parameters
| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `confirm` | boolean | Yes | `true` | Explicit confirmation to purge cache. |
| `vacuum` | boolean | No | `true` | Reclaims disk space and compacts the database file. |

---

## 10. `autodoc_export_openapi`

Compiles a complete OpenAPI 3.1 contract from static code analysis: path/query parameters, request bodies (Zod, Pydantic, DTOs, Go structs), response schemas from handler literals, security schemes, and `$ref` components from the SchemaAnalyzer. See [ADR-005](../decisions/adr-005-openapi-contract-compiler.md).

### Parameters
| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `repoPath` | string | No | Last scanned repo | Target repository root. |
| `title` | string | No | `"AutoDoc-generated API Contract"` | Info section title. |
| `version` | string | No | `"1.0.0"` | Info section version. |
| `serverUrl` | string | No | - | Base server URL for the `servers` block. |
| `output_dir` | string | No | - | When set, writes `openapi.json` to disk; otherwise the document is returned inline. |
| `include_tests` | boolean | No | `false` | Include test suites in endpoint discovery. |
| `llm_enrich` | boolean | No | `false` | LLM-aware: adds LLM-written summaries/descriptions; structure (paths, params, $refs) remains deterministic. |
| `model_profile` | string | No | `auto` | Model profile for LLM enrichment. |

### Response Schema
```json
{
  "status": "SUCCESS",
  "openapiVersion": "3.1.0",
  "operationsCompiled": 2,
  "schemasEmitted": 2,
  "document": { "openapi": "3.1.0", "paths": {}, "components": {} },
  "llmEnriched": true
}
```

---

## 11. `autodoc_llm_status`

Reports host memory/VRAM, the auto-selected local LLM profile, the active model, and availability of LLM enrichment. See [ADR-006](../decisions/adr-006-local-llm-enrichment.md) and [Local LLM Enrichment](../how-to/local-llm-enrichment.md).

### Parameters
| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `model_profile` | string | No | Optional profile (`small`/`mid`/`large`) to probe loading with. |

### Response Schema
```json
{
  "hardware": {
    "device": "cuda",
    "totalRamGb": 31.1,
    "freeRamGb": 18.4,
    "freeVramGb": 5.5,
    "detectedVia": ["os.freemem", "nvidia-smi"]
  },
  "autoSelectedProfile": "large",
  "activeModel": {
    "profile": "small",
    "modelId": "Qwen2.5-Coder-3B-Instruct",
    "contextTokens": 16384,
    "device": "cpu"
  },
  "llmEnrichedAvailable": true,
  "availableProfiles": [
    { "profile": "small", "modelId": "Qwen2.5-Coder-3B-Instruct", "totalBudgetGb": 3, "localWeights": "/path/.autodoc/models/model.gguf" }
  ]
}
```

---

## Error Taxonomy

AutoDoc returns structured error codes across native FFI and MCP layers:

| Error Code | Layer | Meaning |
| :--- | :--- | :--- |
| `AUTODOC_E101` | Core / SQLite | Database initialization failure. |
| `AUTODOC_E102` | Core / SQLite | Transaction conflict or busy timeout. |
| `AUTODOC_E201` | Core / Scanner | File read error or symlink loop detected. |
| `AUTODOC_E301` | Core / Graph | Node or edge not found in Petgraph. |
| `AUTODOC_E401` | FFI Bridge | Native panic intercepted via `catch_unwind`. |
| `AUTODOC_E501` | MCP Protocol | Invalid parameters or rejected operation. |
| `AUTODOC_LLM_E400` | LLM Layer | Unknown model profile (expected `small`, `mid`, `large`, or `auto`). |
| `AUTODOC_LLM_E404` | LLM Layer | No local GGUF weights found or model file missing; deterministic fallback applies. |
