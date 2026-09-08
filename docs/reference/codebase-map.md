# Reference: AutoDoc Self-Mapping & Codebase Topology

This document presents the self-mapped architectural topology of the AutoDoc repository, computed directly by the AutoDoc MCP Server using its parallel Rayon file discovery engine, SQLite WAL persistence, and C4 visualization pipeline.

---

## Repository Metrics

- **Total Source Files Scanned**: 47 (excluding ignored directories, tests artifacts, and third-party dependencies)
- **Total Lines of Code (LOC)**: ~5,676 LOC
- **Primary Languages**: Rust (`rs`), TypeScript (`ts`)
- **Total AST Symbols Indexed**: 224 symbols
- **Total Call Graph Edges**: 68 edges
- **Engine**: NAPI-RS / Rayon Work-Stealing Multi-Threading & Tree-Sitter Polyglot AST
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
        AutoDoc["🔌 AutoDoc System<br/><small>Code intelligence, architecture mapping<br/>and C4 diagram generation</small>"]:::systemClass
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
            MCPServer["🔌 @autodoc/mcp Server<br/><small>Handles tool requests & schemas<br/>formats diagrams & ADRs</small>"]:::mcpClass
        end

        subgraph CoreLayer["Rust Native Engine"]
            CoreEngine["🦀 @autodoc/core Engine<br/><small>Multi-threaded Rayon discovery<br/>Lasso interning • Petgraph pruning</small>"]:::rustClass
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
        ToolRouter["🧭 Tool Router & Dispatcher<br/><small>Routes requests across 11 tools</small>"]:::tsComp
        ZodValidator["🛡️ Schema Validator<br/><small>Strict Zod input schemas</small>"]:::tsComp
        DiagRenderer["📊 Diagram Renderer<br/><small>Mermaid & Structurizr output generator</small>"]:::tsComp
        ArchAnalyzer["🏛️ ArchitectureAnalyzer<br/><small>Dynamic C4 L1-L3 model extractor</small>"]:::tsComp
        ContractSuite["🔍 Realtime & REST Analyzers<br/><small>Socket.io • WebRTC • Express • NestJS</small>"]:::tsComp
        DiataxisGen["📑 DiataxisGenerator<br/><small>Living documentation synthesizer</small>"]:::tsComp
        HonestyAuditor["⚖️ HonestyAnalyzer<br/><small>Dead code & interface cross-checker</small>"]:::tsComp
        FFIBridge["🌉 Node-API Bridge<br/><small>Typed FFI wrappers & boundary</small>"]:::tsComp
    end

    subgraph RustCoreBoundary["⚡ Container: @autodoc/core (Rust Native)"]
        direction TB
        ScannerMod["🦀 scanner::scan_repository<br/><small>Parallel Rayon file walker & Git filter</small>"]:::rustComp
        AstEngine["🌳 parser::ast & heuristics<br/><small>Tree-Sitter + TIOBE Top 20 parser</small>"]:::rustComp
        ComplexityMod["🧮 parser::complexity<br/><small>Cyclomatic complexity calculator</small>"]:::rustComp
        SanitizerMod["🔒 sanitizer::Scrubber<br/><small>Shannon entropy & PII scrubbing</small>"]:::rustComp
        GraphMod["📈 graph::CallGraph<br/><small>Petgraph in-memory centrality pruning</small>"]:::rustComp
        CacheMod["💾 cache::SqliteCache<br/><small>Batch insertion & r2d2_sqlite pool</small>"]:::rustComp
    end

    subgraph StorageBoundary["⚡ Persistence Engine"]
        SQLiteDB[("💾 SQLite WAL (.autodoc/cache.db)<br/><small>Indexed symbols & edges</small>")]:::dbClass
    end

    %% Flow connections
    Client -->|"Calls tool via JSON-RPC stdio"| JSONRPC
    JSONRPC -->|"Dispatches request"| ToolRouter
    ToolRouter -->|"Validates parameters"| ZodValidator
    ZodValidator -->|"Generates diagrams"| DiagRenderer
    ZodValidator -->|"Synthesizes documentation"| DiataxisGen
    DiataxisGen -->|"Audits quirks"| HonestyAuditor
    DiataxisGen -->|"Extracts C4"| ArchAnalyzer
    DiataxisGen -->|"Queries contracts"| ContractSuite
    ToolRouter -->|"Dispatches native compute"| FFIBridge

    FFIBridge -->|"Spawns parallel scan"| ScannerMod
    ScannerMod -->|"Extracts AST symbols"| AstEngine
    AstEngine -->|"Measures decision points"| ComplexityMod
    ScannerMod -->|"Invokes PII scrubbing"| SanitizerMod
    ScannerMod -->|"Writes batch analysis"| CacheMod

    FFIBridge -->|"Queries & prunes graph"| GraphMod
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
    classDef mcpClass fill:#1E1B4B,stroke:#818CF8,stroke-width:2px,color:#FFFFFF;
    classDef rustClass fill:#311505,stroke:#FB923C,stroke-width:2px,color:#FFFFFF;
    classDef glueClass fill:#0F172A,stroke:#38BDF8,stroke-width:2px,color:#FFFFFF,font-weight:bold;

    subgraph TSModels["📦 TypeScript Model Layer (@autodoc/mcp)"]
        direction TB
        AutoDocTools["class AutoDocTools<br/><small>• handleScanRepository()<br/>• handleGetC4Diagram()<br/>• handleGetSymbolContract()<br/>• handleTraceDataFlow()<br/>• handleListApiContracts()<br/>• handleListSocketContracts()<br/>• handleExportDocumentation()<br/>• handleGenerateAdr()<br/>• handlePurgeCache()</small>"]:::tsClass
        Analyzers["Analyzers & Synthesis<br/><small>• ArchitectureAnalyzer<br/>• RestAnalyzer<br/>• RealtimeAnalyzer<br/>• SchemaAnalyzer<br/>• HonestyAnalyzer<br/>• DiataxisGenerator</small>"]:::tsClass
        DiagramRenderer["class DiagramRenderer<br/><small>• escapeHtml()<br/>• sanitizeMermaidId()<br/>• renderC4Mermaid()<br/>• renderStructurizrDsl()</small>"]:::tsClass
    end

    subgraph FFIBoundary["⚡ Node-API Type Boundary (C FFI)"]
        direction TB
        BridgeSignatures["Native FFI Exports<br/><small>• ping(trace_id)<br/>• scan_repository(path, deep, pii)<br/>• sanitize_text(content, mode)<br/>• purge_cache(confirm, vacuum)</small>"]:::glueClass
    end

    subgraph RustModels["📦 Rust Core Data Model (@autodoc-core)"]
        direction TB
        ParsedSymbol["struct ParsedSymbol<br/><small>• name, kind, signature<br/>• cyclomatic_complexity: u32<br/>• line_start, line_end: u32</small>"]:::rustClass
        ScanResult["struct ScanResult #[napi(object)]<br/><small>• scanned_files, total_loc<br/>• total_symbols, total_edges<br/>• languages, pii_redactions</small>"]:::rustClass
        SqliteCache["struct SqliteCache<br/><small>• insert_batch_analysis()<br/>• write_bulk_edges()<br/>• checkpoint_wal(), vacuum()</small>"]:::rustClass
    end

    %% Cross-boundary relationships
    AutoDocTools -->|"Formats visual output"| DiagramRenderer
    AutoDocTools -->|"Coordinates analysis"| Analyzers
    AutoDocTools -->|"Invokes native calls via"| BridgeSignatures

    BridgeSignatures -->|"Returns POD scan"| ScanResult
    BridgeSignatures -->|"Extracts symbols"| ParsedSymbol
    BridgeSignatures -->|"Persists state with"| SqliteCache

    linkStyle default stroke:#94A3B8,stroke-width:2px;
```

---

## Enterprise API & Realtime Contracts Inventory

AutoDoc natively catalogs contracts across multi-decade and modern realtime protocols:
- **REST**:
  - `POST /api/v1/scan` (Auth: `Bearer`)
  - `POST /api/v1/diagrams/c4` (Auth: `Bearer`)
  - `GET /api/v1/symbols/contract` (Auth: `Bearer`)
  - `POST /api/v1/dataflow/trace` (Auth: `Bearer`)
  - `GET /api/v1/contracts` (Auth: `Bearer`)
  - `GET /api/v1/contracts/sockets` (Auth: `Bearer`)
  - `POST /api/v1/export/docs` (Auth: `Bearer`)
  - `POST /api/v1/adr` (Auth: `Bearer`)
  - `DELETE /api/v1/cache` (Auth: `Bearer`)
- **Realtime (WebSocket & WebRTC)**:
  - `webrtc:offer` (Direction: `BIDIRECTIONAL`, Payload: `RTCSessionDescriptionInit | RTCIceCandidateInit`)
  - `webrtc:answer` (Direction: `BIDIRECTIONAL`, Payload: `RTCSessionDescriptionInit | RTCIceCandidateInit`)
  - `webrtc:candidate` (Direction: `BIDIRECTIONAL`, Payload: `RTCSessionDescriptionInit | RTCIceCandidateInit`)
- **gRPC**:
  - `AutoDocService::Ping` (Auth: `None`, Transport: HTTP/2)
- **Extensible Protocols Supported**:
  - `SOAP 1.1 / 1.2` (WSDL/XSD)
  - `GraphQL` (SDL)
  - `CORBA` (OMG IDL)
  - `WCF` (ServiceContracts)
  - `FlatBuffers` / `Cap'n Proto`
