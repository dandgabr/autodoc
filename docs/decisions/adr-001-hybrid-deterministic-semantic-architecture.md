# ADR-001: Hybrid Deterministic and Semantic Architecture of AutoDoc MCP

> Mirrored from ai-memory `decisions/ADR-001-autodoc-mcp-hybrid-architecture.md`. Translated to English from the original Portuguese record.

## Status
Accepted - Foundational Architectural Decision

## Context
AutoDoc is an automated code explorer operating as an MCP (Model Context Protocol) server connected to an AI agent harness to document software repositories and produce complete architectural views (C4 Model Levels 1 through 4, function dictionary, data flow validation, business rules, and ADRs).
The system must support the full technology spectrum of the last 30 years (1994 to 2024+) and the Top 20 languages in the TIOBE index.
Approaches based purely on LLMs suffer from contract hallucinations, context limits on monoliths with millions of lines, and slowness. Traditional purely static approaches (e.g., Doxygen, JavaDoc) fail to extract business intent, implicit architectural decisions, and aggregated conceptual views.

## Decision
A **Four-Layer Hybrid Architecture** is adopted:
1. **Layer 1: Deterministic Static Parsing and Analysis (Polyglot Base TIOBE Top 20)**
   - Use of **Tree-sitter** (C/WASM) for the official high-speed grammars (Python, C, C++, Java, C#, JS/TS, Go, Rust, PHP, Ruby, Swift, Kotlin, etc.).
   - Fallbacks with **ANTLR4** grammars for languages and dialects without a production Tree-sitter grammar (COBOL 85 via ProLeap, Delphi/Pascal, VB6/VBA) and specialized parsers (Roslyn for C#/VB.NET, Clang LibTooling for C/C++, JavaParser/SCIP for Java).
   - Deterministic extraction of unified Call Graphs (CHA and RTA algorithms with worklist), CFG (Control Flow Graph), and DFG (Data Flow Graph in SSA) for data tracking (Taint Analysis).
2. **Layer 2: Canonical Contract Extractors for the Last 30 Years**
   - Deterministic mapping of legacy and modern contracts into a canonical semantic model (`ServiceDefinition` / `EndpointDefinition`):
     - Legacy (1994-2000): CORBA OMG IDL, DCOM TypeLibs (.tlb), Sun RPC (.x), EDI/EDIFACT (.sef), DTD/XML 1.0, EJB 1.x/2.x.
     - SOA (2001-2010): WSDL 1.1/2.0, XSD complexType, WS-Security, WCF ServiceContracts, JMS/IBM MQ.
     - Modern (2011-2020): OpenAPI 2/3 (Swagger), gRPC Protobuf v2/v3, GraphQL SDL, WebSockets, Kafka, RabbitMQ.
     - Contemporary (2021-2026+): Model Context Protocol (MCP), AsyncAPI 3.0, FlatBuffers, Arrow.
3. **Layer 3: AI Semantic Engine, Token Governance, and Mining**
   - **AST Skeletonization**: Pruning of function/method bodies in giant files while preserving signatures, types, annotations, and I/O sinks, reducing token consumption by more than 90%.
   - **Aider RepoMap + Personalized PageRank**: Ranking of the most relevant nodes in the dependency graph, adapted to the context window.
   - **Microsoft GraphRAG / Leiden Algorithm**: Clustering of code nodes into hierarchical communities to identify Bounded Contexts (DDD).
   - **Business Rule Mining**: Reverse analysis of test assertions (BVA, equivalence partitions) formalized into OMG DMN.
   - **Git Archaeology for Retrospective ADRs**: Detection of architectural transition moments and export in the MADR format.
4. **Layer 4: MCP Server and C4 / Diátaxis Pipeline**
   - Exposure via Model Context Protocol in `stdio` and `SSE` modes with core tools (`autodoc_scan_repository`, `autodoc_get_c4_diagram`, `autodoc_get_symbol_contract`, `autodoc_trace_data_flow`, `autodoc_list_api_contracts`, `autodoc_generate_adr`) and virtual resources (`code://c4/{level}`, etc.).
   - Automatic generation of the 4 levels of the C4 Model in Mermaid.js and Structurizr DSL.
   - Organization of the generated documentation under the Diátaxis methodology (Tutorials, How-to, Reference, Explanation).

## Consequences
- **Positive**:
  - 100% accuracy in API contracts, function signatures, and routes through proven static analysis.
  - Ability to analyze massive enterprise repositories (1M to 10M+ LOC) without blowing up context windows through skeletonization and hierarchical clustering.
  - Complete coverage of both 30-year-old legacy systems and modern microservice architectures.
  - Rich documentation with business semantics, visual diagrams, and historical ADRs.
- **Trade-offs / Mitigations**:
  - Need to maintain polyglot bindings for 20 languages -> mitigated by using the Tree-sitter ecosystem compiled to WASM/C with pluggable fallbacks.