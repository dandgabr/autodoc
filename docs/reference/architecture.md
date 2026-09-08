# Reference: System Architecture Specification

Low-level technical specification of the AutoDoc hybrid Rust/TypeScript stack.

---

## High-Level Topology

AutoDoc employs a two-tier architecture:
1. **TypeScript MCP Layer (`packages/autodoc-mcp`)**: Implements the Model Context Protocol JSON-RPC 2.0 lifecycle over `stdio`, schema validation via Zod, and output formatting.
2. **Rust Core Engine (`crates/autodoc-core`)**: Handles compute-intensive operations (tree traversal, string interning, graph algorithms, and SQLite storage) exposed via NAPI-RS native bindings.

```mermaid
flowchart TD
    %% High Contrast Styling Definitions
    classDef clientClass fill:#1E293B,stroke:#0EA5E9,stroke-width:2px,color:#FFFFFF,font-weight:bold;
    classDef mcpClass fill:#1E1B4B,stroke:#818CF8,stroke-width:2px,color:#FFFFFF;
    classDef rustClass fill:#311505,stroke:#FB923C,stroke-width:2px,color:#FFFFFF;
    classDef dbClass fill:#064E3B,stroke:#34D399,stroke-width:2px,color:#FFFFFF;

    subgraph Clients["👤 Clients & Consumers"]
        Dev["Developer / Engineer"]:::clientClass
        Harness["AI Agent Harness<br/><small>Claude Desktop • Antigravity • OpenCode • Cursor</small>"]:::clientClass
    end

    subgraph AutoDocSystem["⚡ AutoDoc Hybrid System Boundary"]
        direction TB

        subgraph MCPLayer["Node.js / TypeScript Host (@autodoc/mcp)"]
            MCPServer["MCP Server (JSON-RPC 2.0 / Stdio)<br/><small>9 Tool Handlers • Zod Validation<br/>i18n • Output Sanitizer</small>"]:::mcpClass
        end

        subgraph CoreLayer["Native Rust Engine (@autodoc/core via Node-API)"]
            NativeCore["Native Engine (NAPI-RS / catch_unwind)<br/><small>Rayon Parallel Scanner • Petgraph<br/>Lasso String Interning</small>"]:::rustClass
        end

        subgraph StorageLayer["Persistence & Caching"]
            Storage["SQLite WAL Engine (.autodoc/cache.db)<br/><small>Covering Indexes • WITHOUT ROWID<br/>r2d2_sqlite Pool</small>"]:::dbClass
        end
    end

    Dev -->|"Prompts architectural queries"| Harness
    Harness -->|"JSON-RPC 2.0 over Stdio"| MCPServer
    MCPServer -->|"Node-API FFI (catch_unwind boundary)"| NativeCore
    NativeCore -->|"Persists files, symbols, and edges"| Storage

    linkStyle default stroke:#94A3B8,stroke-width:2px;
```

---

## Memory Allocation and Footprint (<100MB RSS)

To process repositories with millions of lines of code without exhausting agent memory:
- **String Interning**: Repeated identifiers (package names, file paths, symbol signatures) are interned using `lasso::ThreadedRodeo`. Interned tokens are represented as compact `u32` keys.
- **Compact Graph Nodes**: Petgraph nodes use a plain-old-data (POD) representation sized at 20 bytes per node:
  ```rust
  #[repr(C)]
  pub struct CompactNode {
      pub file_id: u32,
      pub symbol_id: u32,
      pub kind: u8,
      pub flags: u8,
      pub start_line: u32,
      pub end_line: u32,
  }
  ```
- **Custom Global Allocator**: `mimalloc` replaces the system allocator for concurrent multithreaded allocation.

---

## Storage Engine: SQLite in WAL Mode

AutoDoc stores graph metadata in `.autodoc/cache.db`.

### Pragma Configuration
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456; /* 256MB memory-mapped I/O */
PRAGMA cache_size = -32000;   /* 32MB page cache */
```

### Relational Schema
```sql
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    git_oid TEXT NOT NULL,
    loc INTEGER NOT NULL DEFAULT 0,
    scanned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    signature TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    source_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (source_id, target_id, kind)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_edges_incoming_covering 
ON edges (target_id, kind, source_id);
```

The `edges` table uses `WITHOUT ROWID` to eliminate the secondary B-Tree lookup overhead. The `idx_edges_incoming_covering` index resolves reverse dependency and call graph traversals directly from the index tree.

---

## Polyglot AST Engine & Top 20 TIOBE Parsing

AutoDoc employs a tiered static parsing architecture:
1. **Tier 1 (Tree-Sitter Concrete Syntax Trees)**: High-traffic languages (TypeScript, JavaScript, Python, Rust, Go, Java, C/C++) compile tree-sitter grammars directly in the Rust core, extracting exact function definitions, method boundaries, parameter types, return signatures, and docstrings.
2. **Tier 2/3 (Deterministic Regex Heuristics)**: Languages such as SQL (tables, views, procedures), C#, PHP, Ruby, Kotlin, Swift, R, Fortran, Delphi, MATLAB, Perl, Visual Basic, and Bash use precompiled regex heuristics to extract symbol contracts without requiring dozens of external native libraries.
3. **Cyclomatic Complexity**: Measures control flow branching complexity ($CC = 1 + \text{decision points}$) by scanning `if`, `for`, `while`, `catch`, `&&`, `||`, `match`, and `case` tokens, weighting key components in C4 Level 3 diagrams.

---

## Dynamic C4 Synthesis & Realtime Contract Discovery

- **Level 1 (System Context)**: Discovers system boundary, actors, external identity providers, and remote database nodes.
- **Level 2 (Containers)**: Identifies web clients, API gateways, worker pools, and persistence engines by inspecting `package.json` dependencies and source manifests.
- **Level 3 (Components)**: Synthesizes internal component nodes directly from SQLite `symbols` and `edges`, rendering real internal call relationships with sanitized identifiers and WCAG 2.1 AA visual contrast.
- **Realtime Protocols**: The `RealtimeAnalyzer` inspects Socket.io typed interfaces (`ClientToServerEvents`, `ServerToClientEvents`), imperative socket emissions (`socket.on`, `socket.emit`), and WebRTC signaling contracts (`webrtc:offer`, `webrtc:answer`, `webrtc:candidate`).

---

## Living Diátaxis Documentation Generation

The `DiataxisGenerator` synthesizes living documentation directly from the SQLite graph, partitioned into the four Diátaxis quadrants:
- **Tutorials**: Onboarding and quickstart walkthroughs.
- **How-To Guides**: Step-by-step guides for adding modules and endpoints.
- **Reference**: Automated inventories of HTTP REST endpoints, WebSocket/WebRTC events, and data models.
- **Architecture (Explanation)**: System context, container topology, and the honesty quirks report.

