# Reference: AutoDoc Self-Mapping & Codebase Topology

This document presents the self-mapped architectural topology of the AutoDoc repository, computed directly by the AutoDoc MCP Server using its parallel Rayon file discovery engine, SQLite WAL persistence, and C4 visualization pipeline.

---

## Repository Metrics

- **Total Source Files Scanned**: 35 (excluding ignored directories, tests artifacts, and third-party dependencies)
- **Total Lines of Code (LOC)**: ~3,253 LOC
- **Primary Languages**: Rust (`rs`), TypeScript (`ts`)
- **Engine**: NAPI-RS / Rayon Work-Stealing Multi-Threading
- **Cache Location**: `.autodoc/cache.db` (SQLite in WAL mode)
- **PII / Secret Scrubbing**: Active (0 credentials or unmasked tokens persisted)

---

## System Context Diagram (Level 1)
 
```mermaid
flowchart TD
    %% High Contrast Styling Definitions
    classDef clientClass fill:#1E293B,stroke:#0EA5E9,stroke-width:2px,color:#FFFFFF,font-weight:bold;
    classDef systemClass fill:#0F172A,stroke:#38BDF8,stroke-width:2px,color:#FFFFFF,font-weight:bold;

    subgraph Users["👤 User & Client Environment"]
        Dev["fa:fa-user Developer / Engineer<br/><small>Interacts via CLI or AI Chat Interface</small>"]:::clientClass
        Harness["🤖 AI Agent Harness<br/><small>Claude Desktop • Cursor • Antigravity • OpenCode</small>"]:::clientClass
    end

    subgraph SystemBoundary["⚡ Core System Context"]
        AutoDoc["🔌 AutoDoc System<br/><small>Code intelligence, architecture mapping, and C4 diagram generation</small>"]:::systemClass
    end

    Dev -->|"Requests codebase analysis"| Harness
    Harness -->|"Invokes MCP tools over stdio (JSON-RPC 2.0)"| AutoDoc

    linkStyle default stroke:#94A3B8,stroke-width:2px;
```

---

## Container Architecture (Level 2)

```mermaid
flowchart TD
    %% High Contrast Styling Definitions
    classDef clientClass fill:#1E293B,stroke:#0EA5E9,stroke-width:2px,color:#FFFFFF,font-weight:bold;
    classDef mcpClass fill:#1E1B4B,stroke:#818CF8,stroke-width:2px,color:#FFFFFF;
    classDef rustClass fill:#311505,stroke:#FB923C,stroke-width:2px,color:#FFFFFF;
    classDef dbClass fill:#064E3B,stroke:#34D399,stroke-width:2px,color:#FFFFFF;

    subgraph ExternalClients["👤 AI Agent Harness"]
        Agent["🤖 AI Agent Harness (Client)<br/><small>Claude • Cursor • OpenCode • Antigravity</small>"]:::clientClass
    end

    subgraph AutoDocContainers["⚡ AutoDoc Code Explorer Container Boundary"]
        direction TB

        subgraph MCPLayer["Node.js / TypeScript Host"]
            MCPServer["🔌 @autodoc/mcp Server<br/><small>Handles tool requests, validates schemas, formats diagrams & ADRs</small>"]:::mcpClass
        end

        subgraph CoreLayer["Rust Native Engine"]
            CoreEngine["🦀 @autodoc/core Engine<br/><small>Multi-threaded Rayon file discovery, Lasso interning, Petgraph pruning</small>"]:::rustClass
        end

        subgraph DBStorage["Persistence Layer"]
            SQLiteDB[("💾 SQLite WAL Storage (.autodoc/cache.db)<br/><small>Caches AST symbols, call edges, and file metadata</small>")]:::dbClass
        end
    end

    Agent -->|"Dispatches tool calls via stdio"| MCPServer
    MCPServer -->|"Calls native routines via Node-API FFI"| CoreEngine
    CoreEngine -->|"Stores and retrieves index (r2d2_sqlite / WAL)"| SQLiteDB

    linkStyle default stroke:#94A3B8,stroke-width:2px;
```

---

## Component Architecture (Level 3)

The Component diagram details the internal modular structure of both the TypeScript MCP Server and the Rust Core Engine:

```mermaid
flowchart TD
    %% High Contrast Styling Definitions
    classDef clientClass fill:#1E293B,stroke:#0EA5E9,stroke-width:2px,color:#FFFFFF,font-weight:bold;
    classDef tsComp fill:#1E1B4B,stroke:#818CF8,stroke-width:2px,color:#FFFFFF;
    classDef rustComp fill:#311505,stroke:#FB923C,stroke-width:2px,color:#FFFFFF;
    classDef dbClass fill:#064E3B,stroke:#34D399,stroke-width:2px,color:#FFFFFF;

    subgraph ExternalCaller["👤 AI Agent Harness"]
        Client["🤖 Agent Client (Claude / Cursor / Antigravity)"]:::clientClass
    end

    subgraph MCPServerBoundary["⚡ Container: @autodoc/mcp (TypeScript)"]
        direction TB
        JSONRPC["🔌 JSON-RPC 2.0 Transport<br/><small>StdioServerTransport handler</small>"]:::tsComp
        ToolRouter["🧭 Tool Router & Dispatcher<br/><small>Routes requests across 7 tools</small>"]:::tsComp
        ZodValidator["🛡️ Schema Validator<br/><small>Strict Zod input schemas</small>"]:::tsComp
        DiagRenderer["📊 Diagram Renderer<br/><small>Mermaid & Structurizr output generator</small>"]:::tsComp
        I18nEngine["🌐 i18n Localization<br/><small>en-US • pt-BR • es-ES catalogs</small>"]:::tsComp
        FFIBridge["🌉 Node-API Bridge<br/><small>Typed FFI wrappers & boundary</small>"]:::tsComp
    end

    subgraph RustCoreBoundary["⚡ Container: @autodoc/core (Rust Native)"]
        direction TB
        ScannerMod["🦀 scanner::scan_repository<br/><small>Parallel Rayon file walker & Git filter</small>"]:::rustComp
        SanitizerMod["🔒 sanitizer::Scrubber<br/><small>Shannon entropy & PII scrubbing</small>"]:::rustComp
        GraphMod["📈 graph::CallGraph<br/><small>Petgraph in-memory centrality pruning</small>"]:::rustComp
        CacheMod["💾 cache::SqliteCache<br/><small>r2d2_sqlite connection pool</small>"]:::rustComp
    end

    subgraph StorageBoundary["⚡ Persistence Engine"]
        SQLiteDB[("💾 SQLite WAL (.autodoc/cache.db)<br/><small>Indexed symbols & edges</small>")]:::dbClass
    end

    %% Flow connections
    Client -->|"Calls tool via JSON-RPC stdio"| JSONRPC
    JSONRPC -->|"Dispatches request"| ToolRouter
    ToolRouter -->|"Validates parameters"| ZodValidator
    ZodValidator -->|"Generates diagrams"| DiagRenderer
    ZodValidator -->|"Formats localized responses"| I18nEngine
    ToolRouter -->|"Dispatches native compute"| FFIBridge

    FFIBridge -->|"Spawns parallel scan"| ScannerMod
    FFIBridge -->|"Invokes PII scrubbing"| SanitizerMod
    FFIBridge -->|"Queries & prunes graph"| GraphMod

    ScannerMod -->|"Filters files & passes to cache"| CacheMod
    GraphMod -->|"Reads & writes graph state"| CacheMod
    CacheMod -->|"Executes SQL in WAL mode"| SQLiteDB

    linkStyle default stroke:#94A3B8,stroke-width:2px;
```

---

## Code Architecture: Core Class & Struct Model (Level 4)

The Code diagram details the key types, structs, interfaces, and data models that govern interaction across the Node-API boundary:

```mermaid
flowchart TD
    %% High Contrast Styling Definitions
    classDef tsClass fill:#1E1B4B,stroke:#818CF8,stroke-width:2px,color:#FFFFFF;
    classDef rustClass fill:#311505,stroke:#FB923C,stroke-width:2px,color:#FFFFFF;
    classDef glueClass fill:#0F172A,stroke:#38BDF8,stroke-width:2px,color:#FFFFFF,font-weight:bold;

    subgraph TSModels["📦 TypeScript Model Layer (@autodoc/mcp)"]
        direction TB
        AutoDocTools["class AutoDocTools<br/><small>• handleScanRepository()<br/>• handleGetC4Diagram()<br/>• handleGetSymbolContract()<br/>• handleTraceDataFlow()<br/>• handleListApiContracts()<br/>• handleGenerateAdr()<br/>• handlePurgeCache()</small>"]:::tsClass
        DiagramRenderer["class DiagramRenderer<br/><small>• escapeHtml()<br/>• sanitizeMermaidId()<br/>• renderC4Mermaid()<br/>• renderStructurizrDsl()</small>"]:::tsClass
        I18nManager["class I18nManager<br/><small>• t(key, params)<br/>• setLocale(loc)<br/>• getSupportedLocales()</small>"]:::tsClass
    end

    subgraph FFIBoundary["⚡ Node-API Type Boundary (C FFI)"]
        direction TB
        BridgeSignatures["Native FFI Exports<br/><small>• ping(trace_id)<br/>• scan_repository(path, deep, pii)<br/>• sanitize_text(content, mode)<br/>• purge_cache(confirm, vacuum)</small>"]:::glueClass
    end

    subgraph RustModels["📦 Rust Core Data Model (@autodoc-core)"]
        direction TB
        CompactNode["struct CompactNode #[repr(C)]<br/><small>• file_id: u32<br/>• symbol_id: u32<br/>• kind: u8<br/>• flags: u8<br/>• start_line: u32<br/>• end_line: u32</small>"]:::rustClass
        ScanResult["struct ScanResult #[napi(object)]<br/><small>• scanned_files: u32<br/>• total_loc: u32<br/>• languages: Vec&lt;String&gt;<br/>• pii_redactions: u32</small>"]:::rustClass
        SanitizeResult["struct SanitizeResult #[napi(object)]<br/><small>• sanitized_text: String<br/>• redaction_count: u32</small>"]:::rustClass
        SqliteCache["struct SqliteCache<br/><small>• pool: Pool&lt;SqliteConnectionManager&gt;<br/>• insert_file(path, loc)<br/>• insert_symbol(file_id, sym)<br/>• vacuum()</small>"]:::rustClass
    end

    %% Cross-boundary relationships
    AutoDocTools -->|"Formats visual output"| DiagramRenderer
    AutoDocTools -->|"Localizes messages"| I18nManager
    AutoDocTools -->|"Invokes native calls via"| BridgeSignatures

    BridgeSignatures -->|"Returns POD object"| ScanResult
    BridgeSignatures -->|"Returns sanitized text"| SanitizeResult
    BridgeSignatures -->|"Populates POD node"| CompactNode
    BridgeSignatures -->|"Persists state with"| SqliteCache

    linkStyle default stroke:#94A3B8,stroke-width:2px;
```

---

## Enterprise API Contracts Inventory

AutoDoc natively catalogs contracts across multi-decade protocols:
- **REST**:
  - `POST /api/v1/scan` (Auth: `Bearer`)
- **gRPC**:
  - `AutoDocService::Ping` (Auth: `None`, Transport: HTTP/2)
- **Extensible Protocols Supported**:
  - `SOAP 1.1 / 1.2` (WSDL/XSD)
  - `GraphQL` (SDL)
  - `CORBA` (OMG IDL)
  - `WCF` (ServiceContracts)
  - `FlatBuffers` / `Cap'n Proto`
