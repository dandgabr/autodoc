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
flowchart TB
    %% AutoDoc Self-Mapped System Context
    subgraph Boundary_System ["AutoDoc System Boundary"]
        CoreApp["Core Application / MCP Server (@autodoc/mcp)"]
        Database["SQLite WAL Storage Engine (.autodoc/cache.db)"]
        WorkerPool["Parallel Rayon Worker Pool (@autodoc/core)"]
    end
    CoreApp -->|"queries & updates"| Database
    CoreApp -->|"dispatches parallel scan"| WorkerPool
```

---

## Container Architecture (C4 Level 2)

```mermaid
flowchart TB
    subgraph Clients ["AI Agent Harnesses"]
        Claude["Claude Desktop"]
        Cursor["Cursor IDE"]
        OpenCode["OpenCode Local"]
        Antigravity["Google Antigravity"]
    end

    subgraph AutoDocServer ["AutoDoc MCP Server (@autodoc/mcp)"]
        Transport["Stdio Transport (JSON-RPC 2.0)"]
        Tools["7 MCP Tools (Zod Validation)"]
        I18n["I18n & Syntax Masking"]
        XSS["XSS-Free Diagram Renderer"]
    end

    subgraph CoreEngine ["AutoDoc Core Engine (@autodoc/core)"]
        Bridge["NAPI-RS Bridge (catch_unwind)"]
        Scanner["Parallel Rayon File Scanner"]
        Graph["Petgraph & Lasso String Interning"]
        Defense["PII & Secret Defense (Shannon Entropy >= 4.5)"]
        Storage["SQLite WAL Storage Engine"]
    end

    Clients -->|stdio JSON-RPC| Transport
    Transport --> Tools
    Tools --> Bridge
    Bridge --> Scanner
    Bridge --> Graph
    Bridge --> Defense
    Bridge --> Storage
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
