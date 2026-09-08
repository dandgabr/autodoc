# Reference: Codebase Functions & Symbol Catalog

This catalog documents every function, method, struct, and class across the `@autodoc/core` (Rust) and `@autodoc/mcp` (TypeScript) packages.

---

## 1. Rust Core Engine (`crates/autodoc-core`)

### 1.1. Module: `lib.rs` (Node-API FFI Boundary)

| Function / Symbol | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `init_logger` | `pub fn` | `()` | Sets up stderr-only `tracing` subscriber. |
| `ping` | `pub fn` | `(trace_id: String) -> Result<PingResponse>` | Verifies FFI bridge latency and returns version info. |
| `scan_repository_native` | `pub fn` | `(path: String, deep: bool, pii: bool) -> Result<ScanResult>` | Native parallel scanner entrypoint using Rayon. |
| `sanitize_text_native` | `pub fn` | `(content: String, mask_mode: String) -> Result<SanitizeResult>` | Scans and redacts credentials, high entropy keys, and PII. |
| `calculate_entropy_native`| `pub fn` | `(text: String) -> Result<f64>` | Computes Shannon entropy $H$ of text. |
| `wrap_untrusted_native` | `pub fn` | `(raw: String, orig: String, path: String, sym: String) -> Result<String>` | Wraps snippet in `<untrusted_code_context>` tags. |
| `purge_cache_native` | `pub fn` | `(confirm: bool, vacuum: bool) -> Result<bool>` | Truncates tables and executes SQLite vacuum. |
| `controlled_panic_for_testing`| `pub fn` | `() -> Result<()>` | Triggers a panic to verify `catch_unwind` shielding. |

---

### 1.2. Module: `scanner.rs` (Parallel File Traversal)

| Function / Symbol | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `scan_repository` | `pub fn` | `(root: &Path, deep: bool) -> Result<ScanSummary, AutoDocError>` | Traverses filesystem concurrently via Rayon work-stealing pool. |
| `detect_language` | `pub fn` | `(ext: &str) -> Option<&'static str>` | Maps file extension to canonical language tag (`rs`, `ts`, `py`, etc.). |
| `count_lines_of_code` | `pub fn` | `(content: &[u8]) -> usize` | Fast newline counting with SIMD acceleration where available. |
| `is_ignored_path` | `pub fn` | `(path: &Path, gitignore: &GitIgnoreMatcher) -> bool` | Evaluates `.gitignore` and default ignore rules (`node_modules`, `target`, `.git`). |

---

### 1.3. Module: `graph/mod.rs` (In-Memory Dependency Graph)

| Function / Symbol | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `CallGraph::new` | `pub fn` | `() -> Self` | Initializes an empty Petgraph `DiGraph`. |
| `CallGraph::add_node` | `pub fn` | `(&mut self, node: CompactNode) -> NodeIndex` | Inserts a 20-byte POD node into the graph. |
| `CallGraph::add_edge` | `pub fn` | `(&mut self, from: NodeIndex, to: NodeIndex, weight: f32) -> EdgeIndex` | Connects two symbol nodes with a directed call edge. |
| `CallGraph::prune_by_pagerank`| `pub fn` | `(&self, max_nodes: usize) -> CallGraph` | Calculates PageRank centrality scores and keeps top $N$ nodes. |
| `CallGraph::find_path` | `pub fn` | `(&self, start: NodeIndex, target: NodeIndex) -> Option<Vec<NodeIndex>>` | Breadth-first search for data flow taint pathfinding. |
| `CallGraph::export_json` | `pub fn` | `(&self) -> String` | Serializes the graph to JSON format for resource streaming. |

---

### 1.4. Module: `cache/mod.rs` (SQLite WAL Persistence)

| Function / Symbol | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `SqliteCache::new` | `pub fn` | `(path: &Path) -> Result<Self, AutoDocError>` | Opens connection pool via `r2d2_sqlite` and sets WAL pragmas. |
| `SqliteCache::init_schema` | `pub fn` | `(&self) -> Result<(), AutoDocError>` | Executes schema migrations and covering index creation. |
| `SqliteCache::insert_file` | `pub fn` | `(&self, file_path: &str, loc: u32, hash: &str) -> Result<u32, AutoDocError>` | Inserts or updates a file record. |
| `SqliteCache::insert_symbol` | `pub fn` | `(&self, file_id: u32, fqsn: &str, kind: &str, start: u32, end: u32) -> Result<u32, AutoDocError>` | Records an indexed symbol. |
| `SqliteCache::insert_edge` | `pub fn` | `(&self, source_id: u32, target_id: u32, weight: f32) -> Result<(), AutoDocError>` | Stores a call relationship in the `WITHOUT ROWID` edge table. |
| `SqliteCache::checkpoint_wal`| `pub fn` | `(&self) -> Result<(), AutoDocError>` | Executes `PRAGMA wal_checkpoint(PASSIVE)`. |
| `SqliteCache::vacuum` | `pub fn` | `(&self) -> Result<(), AutoDocError>` | Executes `VACUUM` to compact storage. |

---

### 1.5. Module: `sanitizer/` (Defensive Security & Privacy)

| Function / Symbol | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `calculate_shannon_entropy` | `pub fn` | `(s: &str) -> f64` | Measures information density to detect high-entropy keys ($H \ge 4.5$). |
| `Scrubber::new` | `pub fn` | `() -> Self` | Compiles regex patterns for API keys, bearer tokens, passwords. |
| `Scrubber::scrub` | `pub fn` | `(&self, input: &str) -> (String, usize)` | Replaces sensitive matches with `[REDACTED_SECRET]` masks. |
| `PathGuard::normalize` | `pub fn` | `(path: &Path) -> PathBuf` | Strips `..` traversal and returns relative repository paths. |
| `PathGuard::strip_home` | `pub fn` | `(path: &str) -> String` | Replaces `/home/<username>` with `<home>` to prevent user enumeration. |
| `PromptGuard::wrap` | `pub fn` | `(code: &str, orig: &str, path: &str, sym: &str) -> String` | Encloses snippet in `<untrusted_code_context>` XML tags. |

---

## 2. TypeScript MCP Server (`packages/autodoc-mcp`)

### 2.1. Module: `src/index.ts`

| Function / Class | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `createServer` | `export function` | `(): Server` | Instantiates MCP `Server`, registers tool/resource handlers. |
| `main` | `export async function` | `(): Promise<void>` | Boots stdio transport or handles `--print-opencode-config`. |

---

### 2.2. Module: `src/binding.ts`

| Function / Class | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `loadNativeBinding` | `export function` | `(): NativeBinding` | Loads compiled `.node` binary or provides graceful fallback. |

---

### 2.3. Module: `src/tools/handlers.ts`

| Function / Class | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `AutoDocTools` | `export class` | `constructor(binding, i18n)` | Controller coordinating tool execution and FFI invocation. |
| `handleScanRepository` | `export async fn` | `(args: ScanRepositoryInput): Promise<ScanResult>` | Orchestrates repository discovery and metrics computation. |
| `handleGetC4Diagram` | `export async fn` | `(args: GetC4DiagramInput): Promise<{ diagram: string }>` | Dispatches visual diagram generation at requested C4 level. |
| `handleGetSymbolContract` | `export async fn`| `(args: GetSymbolContractInput): Promise<ContractResult>` | Extracts symbol signature wrapped in prompt security boundary. |
| `handleTraceDataFlow` | `export async fn` | `(args: TraceDataFlowInput): Promise<DataFlowResult>` | Traces taint path across call graph from source to sink. |
| `handleListApiContracts`| `export async fn` | `(args: ListApiContractsInput): Promise<ApiListResult>` | Returns inventory of exposed and consumed API protocols. |
| `handleGenerateAdr` | `export async fn` | `(args: GenerateAdrInput): Promise<{ adr: string }>` | Synthesizes localized MADR markdown decision record. |
| `handlePurgeCache` | `export async fn` | `(args: PurgeCacheInput): Promise<PurgeResult>` | Executes SQLite purge and vacuum operations. |

---

### 2.4. Module: `src/diagrams/renderer.ts`

| Function / Method | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `DiagramRenderer.escapeHtml` | `public static` | `(text: string): string` | Escapes `&`, `<`, `>`, `"`, `'`, and neutralizes `javascript:` URIs. |
| `DiagramRenderer.sanitizeMermaidId` | `public static` | `(id: string): string` | Replaces non-alphanumeric characters with `_` for Mermaid tokens. |
| `DiagramRenderer.renderC4Mermaid` | `public static` | `(options: DiagramOptions): string` | Emits official Mermaid C4 syntax (`C4Context`, `C4Container`, `C4Component`). |
| `DiagramRenderer.renderStructurizrDsl` | `public static` | `(title, nodes, edges): string` | Emits Structurizr DSL workspace definition. |

---

### 2.5. Module: `src/i18n/index.ts` & `src/i18n/masker.ts`

| Function / Class | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `I18nManager` | `export class` | `constructor(locale?: string)` | Manages multi-locale translations (`en-US`, `pt-BR`, `es-ES`). |
| `I18nManager.t` | `public` | `(key: string, params?: object): string` | Retrieves translated string with optional token interpolation. |
| `I18nManager.setLocale` | `public` | `(locale: string): void` | Switches active language catalog at runtime. |
| `I18nManager.getSupportedLocales` | `public` | `(): string[]` | Returns list of available locale identifiers. |
| `maskPii` | `export function` | `(text: string, locale: string): string` | Replaces region-specific PII (e.g. CPF, SSN) with masked tokens. |

---

### 2.6. Module: `src/logger.ts` & `src/errors.ts`

| Function / Class | Visibility | Signature | Description |
| :--- | :--- | :--- | :--- |
| `Logger.info` | `public static` | `(msg: string): void` | Writes formatted info log to `process.stderr`. |
| `Logger.warn` | `public static` | `(msg: string): void` | Writes formatted warning log to `process.stderr`. |
| `Logger.error` | `public static` | `(msg: string): void` | Writes formatted error log to `process.stderr`. |
| `AutoDocException` | `export class` | `constructor(code, msg, details?)` | Typed exception embedding standardized `AUTODOC_Exxx` error codes. |
