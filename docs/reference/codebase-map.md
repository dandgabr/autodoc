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
