# Reference: AutoDoc Self-Mapping & Codebase Topology

This document presents the self-mapped architectural topology of the AutoDoc repository, computed directly by the AutoDoc MCP Server using its parallel Rayon file discovery engine, SQLite WAL persistence, and C4 visualization pipeline.

---

## Repository Metrics

- **Total Source Files Scanned**: 35 (excluding ignored directories, tests artifacts, and third-party dependencies)
- **Total Lines of Code (LOC)**: ~3,192 LOC
- **Primary Languages**: Rust (`rs`), TypeScript (`ts`)
- **Engine**: NAPI-RS / Rayon Work-Stealing Multi-Threading
- **Cache Location**: `.autodoc/cache.db` (SQLite in WAL mode)
- **PII / Secret Scrubbing**: Active (0 credentials or unmasked tokens persisted)

---

## System Context Diagram (C4 Level 1)
 
```mermaid
C4Context
    title AutoDoc Self-Mapped System Context

    Person(developer, "Developer / Engineer", "Interacts with coding assistant or CLI.")
    System(autodoc, "AutoDoc System", "Code intelligence, architecture mapping, and C4 diagram generation.")
    System_Ext(agent, "AI Agent Harness", "Claude Desktop, Cursor, Antigravity, OpenCode")

    Rel(developer, agent, "Requests codebase analysis")
    Rel(agent, autodoc, "Invokes MCP tools over stdio", "JSON-RPC 2.0")
```

---

## Container Architecture (C4 Level 2)

```mermaid
C4Container
    title AutoDoc Internal Container Architecture

    System_Ext(agent, "AI Agent Harness", "Claude, Cursor, OpenCode, Antigravity")

    Container_Boundary(b1, "AutoDoc Code Explorer") {
        Container(mcp_server, "@autodoc/mcp Server", "Node.js / TypeScript", "Handles tool requests, validates schemas, formats C4 diagrams and ADRs")
        Container(core_engine, "@autodoc/core Engine", "Rust 2021 / Rayon", "Multi-threaded file discovery, Lasso interning, Petgraph pruning")
        ContainerDb(sqlite_db, "SQLite WAL Storage", "SQLite 3", "Caches AST symbols, edges, and file metadata")
    }

    Rel(agent, mcp_server, "Dispatches tool calls", "stdio")
    Rel(mcp_server, core_engine, "Calls native bindings", "Node-API FFI")
    Rel(core_engine, sqlite_db, "Stores and retrieves index", "r2d2_sqlite / WAL")
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
