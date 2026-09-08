# Reference: MCP Tools Specification

This document provides technical specifications for the seven Model Context Protocol (MCP) tools implemented in `@autodoc/mcp`.

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
  "scannedFiles": 42,
  "engine": "NAPI-RS / Rayon",
  "piiScrubbed": true,
  "cacheLocation": ".autodoc/cache.db"
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

---

## 7. `autodoc_purge_cache`

Truncates and vacuums local SQLite cache files to comply with GDPR/LGPD Right to be Forgotten.

### Parameters
| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `confirm` | boolean | Yes | `true` | Explicit confirmation to purge cache. |
| `vacuum` | boolean | No | `true` | Reclaims disk space and compacts the database file. |

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
