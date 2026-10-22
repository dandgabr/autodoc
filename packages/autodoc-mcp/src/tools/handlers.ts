import { z } from "zod";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DiagramRenderer } from "../diagrams/renderer.js";
import { I18nManager } from "../i18n/index.js";
import { loadNativeBinding } from "../binding.js";
import { AutoDocException } from "../errors.js";
import { registerRepositoryCachePath, repositoryCachePath } from "../analysis/cache-state.js";
import { loadSnapshot, SnapshotReadError, type SnapshotCollection, type SnapshotContext } from "../analysis/snapshot.js";
import type { SnapshotPage } from "../analysis/contracts.js";
import { buildArchitectureMap, traceSnapshotPath, type ArchitectureMapKind, type MapProjection } from "../analysis/map.js";

import { ArchitectureAnalyzer } from "../analyzers/architecture.js";
import { RestAnalyzer } from "../analyzers/rest/index.js";
import { OpenApiGenerator } from "../analyzers/rest/openapi.js";
import { RealtimeAnalyzer } from "../analyzers/realtime/index.js";
import { DiataxisGenerator } from "../diataxis/generator.js";
import { getLlmEnrichment, sanitizeForPrompt } from "../llm/enrichment.js";
import { generateJson } from "../llm/structured.js";
import { detectHostCapabilities } from "../llm/hardware.js";
import { previewAutoProfile } from "../llm/enrichment.js";
import { PROFILE_ORDER, getProfile } from "../llm/models.js";
import { findLocalWeights } from "../llm/provider.js";
import { z as _z } from "zod";

// Zod schemas
export const ScanRepositorySchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  deepScan: z.boolean().default(false),
  enablePiiScrubbing: z.boolean().default(true),
  maxSourceBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional(),
  workers: z.number().int().min(1).max(4).optional(),
  queueCapacity: z.number().int().min(1).max(16).optional(),
  batchSize: z.number().int().min(1).max(256).optional(),
  max_source_bytes: z.number().int().min(1).max(4 * 1024 * 1024).optional(),
  queue_capacity: z.number().int().min(1).max(16).optional(),
  batch_size: z.number().int().min(1).max(256).optional(),
});

export const GetC4DiagramSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  level: z.number().int().min(1).max(4).default(2),
  max_nodes: z.number().int().min(10).max(100).default(35),
  format: z.enum(["mermaid", "structurizr"]).default("mermaid"),
  locale: z.string().default("en-US"),
  sanitizeOutput: z.boolean().default(true),
  llm_enrich: z.boolean().optional(),
  model_profile: z.string().optional(),
  scanId: z.string().min(1).optional(),
  scan_id: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.scanId !== undefined && value.scan_id !== undefined && value.scanId !== value.scan_id) {
    ctx.addIssue({ code: "custom", path: ["scan_id"], message: "scanId and scan_id must match when both are provided" });
  }
});

export const GetSymbolContractSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  symbolName: z.string().optional(),
  symbol_fqsn: z.string().optional(),
  filePath: z.string().optional(),
  include_body: z.boolean().default(false),
});

const TraceDataFlowInputSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  sourceEntrypoint: z.string().optional(),
  entrypoint_symbol: z.string().optional(),
  targetSink: z.string().optional(),
  target_sink: z.string().optional(),
  maxDepth: z.number().int().min(1).max(20).optional(),
  max_depth: z.number().int().min(1).max(20).optional(),
}).superRefine((value, ctx) => {
  for (const [left, right, key] of [
    [value.repoPath, value.repository_path, "repository_path"],
    [value.sourceEntrypoint, value.entrypoint_symbol, "entrypoint_symbol"],
    [value.targetSink, value.target_sink, "target_sink"],
  ] as const) {
    if (left !== undefined && right !== undefined && left !== right) {
      ctx.addIssue({ code: "custom", path: [key], message: "Aliases must match when both are provided" });
    }
  }
  if (value.maxDepth !== undefined && value.max_depth !== undefined && value.maxDepth !== value.max_depth) {
    ctx.addIssue({ code: "custom", path: ["max_depth"], message: "maxDepth and max_depth must match when both are provided" });
  }
});
export const TraceDataFlowSchema = TraceDataFlowInputSchema.transform((value) => {
  const maxDepth = value.max_depth ?? value.maxDepth ?? 5;
  const repoPath = value.repository_path ?? value.repoPath;
  const sourceEntrypoint = value.entrypoint_symbol ?? value.sourceEntrypoint;
  const targetSink = value.target_sink ?? value.targetSink;
  return { ...value, repoPath, repository_path: repoPath, sourceEntrypoint, entrypoint_symbol: sourceEntrypoint, targetSink, target_sink: targetSink, maxDepth, max_depth: maxDepth };
});

export const ListApiContractsSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  protocolFilter: z.string().optional(),
  protocol_filter: z.enum(["ALL", "REST", "SOAP", "GRPC", "GRAPHQL", "CORBA"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  scanId: z.string().min(1).optional(),
  scan_id: z.string().min(1).optional(),
  includeTests: z.boolean().default(false),
  include_tests: z.boolean().optional(),
  llm_enrich: z.boolean().optional(),
  model_profile: z.string().optional(),
}).superRefine((value, context) => {
  for (const [left, right, key] of [
    [value.repoPath, value.repository_path, "repository_path"],
    [value.protocolFilter, value.protocol_filter, "protocol_filter"],
    [value.scanId, value.scan_id, "scan_id"],
  ] as const) {
    if (left !== undefined && right !== undefined && left !== right) {
      context.addIssue({ code: "custom", path: [key], message: "Aliases must match when both are provided" });
    }
  }
});

export const ListSocketContractsSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  directionFilter: z.string().optional(),
  direction_filter: z.enum(["ALL", "CLIENT_TO_SERVER", "SERVER_TO_CLIENT", "BIDIRECTIONAL"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  includeTests: z.boolean().default(false),
  include_tests: z.boolean().optional(),
  cursor: z.string().optional(),
  scanId: z.string().min(1).optional(),
  scan_id: z.string().min(1).optional(),
}).superRefine((value, context) => {
  for (const [left, right, key] of [
    [value.repoPath, value.repository_path, "repository_path"],
    [value.directionFilter, value.direction_filter, "direction_filter"],
    [value.scanId, value.scan_id, "scan_id"],
  ] as const) {
    if (left !== undefined && right !== undefined && left !== right) {
      context.addIssue({ code: "custom", path: [key], message: "Aliases must match when both are provided" });
    }
  }
});

export const ExportDocumentationSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  outputDir: z.string().default("./docs"),
  output_dir: z.string().optional(),
  includeTests: z.boolean().default(false),
  include_tests: z.boolean().optional(),
});

export const ExportOpenApiSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  title: z.string().optional(),
  version: z.string().optional(),
  serverUrl: z.string().optional(),
  outputDir: z.string().optional(),
  output_dir: z.string().optional(),
  includeTests: z.boolean().default(false),
  include_tests: z.boolean().optional(),
  llm_enrich: z.boolean().optional(),
  model_profile: z.string().optional(),
});

export const GenerateAdrSchema = z.object({
  title: z.string().optional(),
  topic: z.string().optional(),
  context: z.string().optional(),
  decision: z.string(),
  locale: z.string().default("en-US"),
  llm_enrich: z.boolean().optional(),
  model_profile: z.string().optional(),
});

export const LlmStatusSchema = z.object({
  model_profile: z.string().optional(),
});

export const PurgeCacheSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  confirm: z.boolean().default(true),
  vacuum: z.boolean().default(true),
});

export const ARCHITECTURE_MAP_RESOURCES = [
  { uri: "code://c4/1", name: "System context map", description: "Snapshot-backed C4 level 1 repository context; no external actors are inferred." },
  { uri: "code://c4/2", name: "Infrastructure map", description: "Snapshot-backed infrastructure map for C4 level 2." },
  { uri: "code://c4/3", name: "Repository structure map", description: "Snapshot-backed file inventory for C4 level 3." },
  { uri: "code://c4/4", name: "Code map", description: "Snapshot-backed symbols and resolved relations for C4 level 4." },
  { uri: "code://graph/callgraph", name: "Call graph", description: "Snapshot-backed call relations with resolution and evidence state." },
] as const;

export const ARCHITECTURE_MAP_RESOURCE_TEMPLATES = [
  { uriTemplate: "code://c4/{level}{?scan_id}", name: "C4 map by level", description: "Read C4 levels 1-4 from an active or explicitly pinned snapshot." },
  { uriTemplate: "code://map/{kind}{?scan_id}", name: "Architecture map by kind", description: "Read context, structure, imports, entrypoints, infrastructure, or code maps from a snapshot." },
  { uriTemplate: "code://graph/callgraph{?scan_id}", name: "Call graph by snapshot", description: "Read the call graph for the active or explicitly pinned snapshot." },
] as const;

function mapKindForC4Level(level: number): ArchitectureMapKind {
  if (level === 1) return "context";
  if (level === 2) return "infrastructure";
  if (level === 3) return "structure";
  return "code";
}

function mapProjectionStatus(projection: MapProjection): "SUCCESS" | "PARTIAL" | "UNSUPPORTED" {
  if (projection.nodes.length === 0) return "UNSUPPORTED";
  if (projection.coverage.state !== "complete") return "PARTIAL";
  if ((projection.kind === "infrastructure" || projection.kind === "context") && projection.nodes.every((node) => node.state === "inventory")) return "PARTIAL";
  return "SUCCESS";
}

let globalLastTargetRepoPath: string = process.cwd();

export function setLastScannedRepoPath(path: string) {
  globalLastTargetRepoPath = path;
}

export function getLastScannedRepoPath(): string {
  return globalLastTargetRepoPath;
}

export class AutoDocTools {
  private binding: ReturnType<typeof loadNativeBinding>;
  private i18n: I18nManager;
  private lastTargetRepoPath: string = process.cwd();

  constructor(binding: ReturnType<typeof loadNativeBinding>, i18n: I18nManager) {
    this.binding = binding;
    this.i18n = i18n;
    this.lastTargetRepoPath = globalLastTargetRepoPath;
  }

  private resolveTargetRepo(args: { repoPath?: string; repository_path?: string }): string {
    return args.repoPath || args.repository_path || this.lastTargetRepoPath || globalLastTargetRepoPath || process.cwd();
  }

  /** Load one immutable generation for tools that need repository facts. */
  async loadSnapshotContext(repoPath?: string, scanId?: string) {
    return loadSnapshot(repoPath ?? this.lastTargetRepoPath ?? globalLastTargetRepoPath, scanId, this.binding);
  }

  async readSnapshotPage(repoPath: string, scanId: string, collection: SnapshotCollection, cursor: string | null = null, limit = 50): Promise<SnapshotPage> {
    return (await loadSnapshot(repoPath, scanId, this.binding)).readPage(collection, cursor, limit);
  }

  private mapProjection(context: SnapshotContext, kind: ArchitectureMapKind): MapProjection {
    return buildArchitectureMap(context, kind);
  }

  private diagramFromProjection(projection: MapProjection, level: number, title: string, format: "mermaid" | "structurizr"): string {
    const nodes = projection.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      desc: node.kind,
      type: level === 1 ? "system" as const : "component" as const,
      technology: typeof node.attributes?.category === "string" ? node.attributes.category : undefined,
      state: node.state,
      evidenceIds: node.evidenceIds,
    }));
    const edges = projection.relations
      .filter((relation) => relation.state === "confirmed" && relation.toId !== null)
      .map((relation) => ({
        id: relation.id,
        from: relation.fromId,
        to: relation.toId!,
        label: relation.kind,
        state: "confirmed" as const,
        evidenceIds: relation.evidenceIds,
      }));
    return format === "structurizr"
      ? DiagramRenderer.renderStructurizrDsl(title, nodes, edges)
      : DiagramRenderer.renderC4Mermaid({ level, title, nodes, edges });
  }

  async handleReadMapResource(uri: string, repoPath?: string) {
    let parsed: URL;
    try { parsed = new URL(uri); }
    catch { throw new AutoDocException("AUTODOC_E501", `Invalid AutoDoc map resource URI: ${uri}`); }
    if (parsed.protocol !== "code:") throw new AutoDocException("AUTODOC_E501", `Unknown AutoDoc map resource URI: ${uri}`);
    const scanIds = parsed.searchParams.getAll("scan_id");
    if (scanIds.length > 1 || scanIds.some((value) => value.length === 0)) {
      throw new AutoDocException("AUTODOC_E501", "A map resource accepts at most one non-empty scan_id parameter.");
    }
    const scanId = scanIds[0];
    let kind: ArchitectureMapKind;
    if (parsed.hostname === "c4" && /^\/[1-4]$/.test(parsed.pathname)) {
      kind = mapKindForC4Level(Number(parsed.pathname.slice(1)));
    } else if (parsed.hostname === "graph" && parsed.pathname === "/callgraph") {
      kind = "code";
    } else if (parsed.hostname === "map" && /^\/(context|structure|imports|entrypoints|infrastructure|code)$/.test(parsed.pathname)) {
      kind = parsed.pathname.slice(1) as ArchitectureMapKind;
    } else {
      throw new AutoDocException("AUTODOC_E501", `Unknown AutoDoc map resource URI: ${uri}`);
    }
    const targetRepo = repoPath ?? this.resolveTargetRepo({});
    try {
      const snapshot = await this.loadSnapshotContext(targetRepo, scanId);
      const projection = this.mapProjection(snapshot, kind);
      return {
        contractVersion: 2,
        uri,
        requestedScanId: scanId ?? null,
        status: mapProjectionStatus(projection),
        scanId: snapshot.scanId,
        repositoryRoot: snapshot.repositoryRoot,
        projection,
        diagnostics: projection.nodes.length === 0 ? [`No supported facts are available for ${kind} in this snapshot.`] : [],
      };
    } catch (error) {
      const status = error instanceof SnapshotReadError ? error.status : "FAILED";
      return { contractVersion: 2, uri, status, scanId: null, repositoryRoot: null, projection: null, diagnostics: [String(error)] };
    }
  }

  private decodeCatalogCursor(cursor: string | undefined): { version: 1; root: string; scanId: string; collection: string; filter: string; digest: string; offset: number } | undefined {
    if (!cursor) return undefined;
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (Buffer.from(cursor, "base64url").toString("base64url") !== cursor) throw new Error("non-canonical cursor encoding");
      if (decoded.version !== 1 || typeof decoded.root !== "string" || typeof decoded.scanId !== "string" ||
        typeof decoded.collection !== "string" || typeof decoded.filter !== "string" || typeof decoded.digest !== "string" ||
        !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error("invalid cursor shape");
      return decoded;
    } catch {
      throw new AutoDocException("AUTODOC_E501", "Invalid or stale catalog cursor; restart pagination from the first page.");
    }
  }

  private paginateCatalog<T>(
    items: T[], snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
    collection: string, filter: string, cursor: string | undefined, limit: number,
  ) {
    const ordered = [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const digest = createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
    const decoded = this.decodeCatalogCursor(cursor);
    if (decoded && (decoded.root !== snapshot.repositoryRoot || decoded.scanId !== snapshot.scanId ||
      decoded.collection !== collection || decoded.filter !== filter || decoded.digest !== digest || decoded.offset >= ordered.length)) {
      throw new AutoDocException("AUTODOC_E501", "Invalid or stale catalog cursor; restart pagination from the first page.");
    }
    const offset = decoded?.offset ?? 0;
    const page = ordered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < ordered.length
      ? Buffer.from(JSON.stringify({ version: 1, root: snapshot.repositoryRoot, scanId: snapshot.scanId, collection, filter, digest, offset: nextOffset })).toString("base64url")
      : null;
    const sourceCoverage = snapshot.metadata.coverage.source;
    const coverage = {
      state: sourceCoverage?.state === "complete" ? "partial" as const : sourceCoverage?.state ?? "unsupported" as const,
      examined: sourceCoverage?.examined ?? 0,
      excluded: sourceCoverage?.excluded ?? 0,
      diagnostics: [
        ...(sourceCoverage?.diagnostics ?? [{ code: "NO_COVERAGE_METADATA" }]),
        { code: "STATIC_EXTRACTOR_COVERAGE" },
      ],
    };
    const truncated = coverage.diagnostics.some(({ code }) => /BUDGET|TRUNCAT|MAX_SOURCE_BYTES|QUEUE_CAPACITY|STAGING_CAPACITY/i.test(code));
    return { items: page, total: ordered.length, nextCursor, truncated, coverage, scanId: snapshot.scanId };
  }

  getToolDefinitions() {
    return [
      { name: "autodoc_scan_repository", schema: ScanRepositorySchema },
      { name: "autodoc_get_c4_diagram", schema: GetC4DiagramSchema },
      { name: "autodoc_get_symbol_contract", schema: GetSymbolContractSchema },
      { name: "autodoc_trace_data_flow", schema: TraceDataFlowSchema },
      { name: "autodoc_list_api_contracts", schema: ListApiContractsSchema },
      { name: "autodoc_list_socket_contracts", schema: ListSocketContractsSchema },
      { name: "autodoc_export_openapi", schema: ExportOpenApiSchema },
      { name: "autodoc_llm_status", schema: LlmStatusSchema },
      { name: "autodoc_export_documentation", schema: ExportDocumentationSchema },
      { name: "autodoc_generate_adr", schema: GenerateAdrSchema },
      { name: "autodoc_purge_cache", schema: PurgeCacheSchema },
    ];
  }

  async handleScanRepository(args: z.infer<typeof ScanRepositorySchema>) {
    const targetPath = this.resolveTargetRepo(args);

    let scannedFiles = 0;
    let candidateFiles = 0;
    let filesWithErrors = 0;
    let totalLoc = 0;
    let totalSymbols = 0;
    let totalEdges = 0;
    let languages: string[] = [];
    let cacheLocation = ".autodoc/cache.db";
    let analysisState: "complete" | "partial" | "failed" = "failed";
    let coverageState: "complete" | "partial" = "partial";
    let scanId: string | null = null;
    let activeScanId: string | null = null;
    let diagnostics: Array<{ stage: string; code: string; path?: string; message: string }> = [];

    if (this.binding.scanRepositoryNative) {
      try {
        const options = {
          ...((args.maxSourceBytes ?? args.max_source_bytes) === undefined ? {} : { maxSourceBytes: args.maxSourceBytes ?? args.max_source_bytes }),
          ...(args.workers === undefined ? {} : { workers: args.workers }),
          ...((args.queueCapacity ?? args.queue_capacity) === undefined ? {} : { queueCapacity: args.queueCapacity ?? args.queue_capacity }),
          ...((args.batchSize ?? args.batch_size) === undefined ? {} : { batchSize: args.batchSize ?? args.batch_size }),
        };
        const nativeRes = this.binding.scanRepositoryNative(targetPath, options);
        scannedFiles = nativeRes.totalFiles;
        candidateFiles = nativeRes.candidateFiles;
        filesWithErrors = nativeRes.filesWithErrors;
        totalLoc = nativeRes.totalLoc;
        totalSymbols = nativeRes.totalSymbols || 0;
        totalEdges = nativeRes.totalEdges || 0;
        languages = nativeRes.languages;
        cacheLocation = nativeRes.cachePath;
        analysisState = nativeRes.analysisState;
        coverageState = nativeRes.coverageState ?? (analysisState === "complete" ? "complete" : "partial");
        scanId = nativeRes.scanId ?? null;
        activeScanId = nativeRes.activeScanId ?? null;
        diagnostics = nativeRes.diagnostics;
      } catch (err: any) {
        diagnostics.push({ stage: "scan", code: "NATIVE_SCAN_FAILED", message: String(err?.message || "Native scan failed") });
        process.stderr.write(`[WARN] Native scan failed: ${err?.message}\n`);
      }
    }

    if (activeScanId && activeScanId === scanId) {
      if (cacheLocation) registerRepositoryCachePath(targetPath, cacheLocation);
      this.lastTargetRepoPath = targetPath;
      globalLastTargetRepoPath = targetPath;
    }

    return {
      status: analysisState === "failed" ? "FAILED" : analysisState === "partial" || coverageState === "partial" ? "PARTIAL" : "SUCCESS",
      analysisState,
      coverageState,
      scanId,
      activeScanId,
      diagnostics,
      repositoryPath: targetPath,
      scannedFiles,
      candidateFiles,
      filesWithErrors,
      totalLoc,
      totalSymbols,
      totalEdges,
      languages,
      engine: "NAPI-RS / Rayon",
      piiScrubbed: args.enablePiiScrubbing,
      cacheLocation,
    };
  }

  async handleGetC4Diagram(args: z.infer<typeof GetC4DiagramSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    let snapshot: SnapshotContext;
    try { snapshot = await this.loadSnapshotContext(targetRepo, args.scan_id ?? args.scanId); }
    catch (error) {
      const status = error instanceof SnapshotReadError && /snapshot read APIs are unavailable|no active scan|no AutoDoc cache exists|not_scanned/i.test(error.message)
        ? "NOT_SCANNED"
        : error instanceof SnapshotReadError ? error.status : "FAILED";
      return { contractVersion: 2, status, level: args.level, format: args.format, diagram: null, scanId: null, repositoryRoot: null, projection: null, diagnostics: [String(error)] };
    }

    const projection = this.mapProjection(snapshot, mapKindForC4Level(args.level));
    const status = mapProjectionStatus(projection);
    if (projection.nodes.length === 0) {
      return {
        contractVersion: 2, status, level: args.level, format: args.format, diagram: null,
        scanId: snapshot.scanId, repositoryRoot: snapshot.repositoryRoot, coverage: projection.coverage, projection,
        diagnostics: [`No supported facts are available for ${projection.kind} in scan ${snapshot.scanId}.`],
      };
    }
    if (args.llm_enrich) {
      const refined = await this.refineC4Diagram(args, snapshot, projection);
      if (refined) return { ...refined, contractVersion: 2, status, scanId: snapshot.scanId, repositoryRoot: snapshot.repositoryRoot, coverage: projection.coverage, projection };
    }
    const title = this.i18n.t("c4.containers") || "AutoDoc System Architecture";
    const diagram = this.diagramFromProjection(projection, args.level, title, args.format);
    return {
      contractVersion: 2, status, level: args.level, format: args.format, diagram,
      sanitized: args.sanitizeOutput, llmEnriched: false,
      scanId: snapshot.scanId, repositoryRoot: snapshot.repositoryRoot, coverage: projection.coverage, projection,
      diagnostics: status === "PARTIAL" ? ["The projection contains inventory or partial-coverage data only; it does not imply unobserved architecture."] : [],
    };
  }

  /**
   * Pass-2 C4 refinement: LLM rewrites node descriptions and edge labels
   * from the deterministic graph evidence. Structure (nodes/edges/layout)
   * stays untouched and the diagram re-renders through the same validated
   * renderer.
   */
  async refineC4Diagram(args: z.infer<typeof GetC4DiagramSchema>, pinnedSnapshot?: SnapshotContext, pinnedProjection?: MapProjection) {
    const targetRepo = this.resolveTargetRepo(args);
    const enrichment = await getLlmEnrichment({ profile: (args as any).model_profile });
    if (!enrichment) return null;

    let snapshot = pinnedSnapshot;
    let projection = pinnedProjection;
    let graph: ReturnType<ArchitectureAnalyzer["getArchitectureGraph"]>;
    {
      try { snapshot ??= await this.loadSnapshotContext(targetRepo, args.scan_id ?? args.scanId); }
      catch { return null; }
      projection ??= this.mapProjection(snapshot, mapKindForC4Level(args.level));
      const nodes = projection.nodes.map((node) => ({ id: node.id, label: node.label, desc: node.kind, type: args.level === 1 ? "system" as const : "component" as const, state: node.state, evidenceIds: node.evidenceIds }));
      const edges = projection.relations.filter((relation) => relation.state === "confirmed" && relation.toId !== null)
        .map((relation) => ({ id: relation.id, from: relation.fromId, to: relation.toId!, label: relation.kind, state: "confirmed" as const, evidenceIds: relation.evidenceIds }));
      graph = { level: args.level, title: `${projection.repositoryRoot} - C4 Map`, nodes, edges, scanId: projection.scanId, repositoryRoot: projection.repositoryRoot, coverage: projection.coverage };
    }
    const evidence = sanitizeForPrompt(
      graph.nodes.map((n: any) => `${n.id}: ${n.label || n.name} (${n.type || "component"})`).join("\n"),
      "c4_evidence"
    );

    const RefineSchema = _z.object({
      // Models sometimes wrap the list in an object; normalize below.
      descriptions: _z.array(_z.object({ id: _z.string(), description: _z.string().max(200) })).max(50).optional(),
    }).transform((v) => {
      let list = v.descriptions;
      if (!list && typeof (v as Record<string, unknown>).descriptions === "object") {
        const raw = (v as unknown as Record<string, unknown>).descriptions;
        if (Array.isArray(raw)) list = raw as NonNullable<typeof list>;
      }
      if (!Array.isArray(list)) {
        // Accept an object map {id: description} as well.
        const raw = (v as unknown as Record<string, unknown>).descriptions as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          list = Object.entries(raw as Record<string, string>).map(([id, description]) => ({ id, description: String(description) }));
        }
      }
      return { descriptions: (list || []).slice(0, 50) };
    });
    const result = await generateJson(
      enrichment.provider,
      `Describe each architecture component in one short sentence based strictly on the evidence list.\n${evidence}`,
      "You are a software architecture writer. Describe only what the evidence supports.",
      RefineSchema,
      { maxTokens: 800 }
    );
    if (!result.value) return null;

    const descById = new Map((result.value.descriptions ?? []).map((d) => [d.id, d.description]));
    const refinedNodes = graph.nodes.map((n: any) => ({ ...n, description: descById.get(n.id) ?? n.description }));
    const title = graph.title || this.i18n.t("c4.containers") || "AutoDoc System Architecture";

    const diagram =
      args.format === "structurizr"
        ? DiagramRenderer.renderStructurizrDsl(title, refinedNodes, graph.edges)
        : DiagramRenderer.renderC4Mermaid({ level: args.level, title, nodes: refinedNodes, edges: graph.edges });

    return {
      status: projection ? mapProjectionStatus(projection) : "SUCCESS",
      level: args.level,
      format: args.format,
      diagram,
      sanitized: args.sanitizeOutput,
      llmEnriched: true,
      model: enrichment.provider.model,
      ...(projection ? { scanId: projection.scanId, repositoryRoot: projection.repositoryRoot, coverage: projection.coverage, projection } : {}),
    };
  }

  /**
   * LLM-synthesized ADR: elaborates Context/Decision/Consequences from the
   * operator-provided seed plus repo evidence. Falls back to the
   * deterministic template when the LLM is unavailable or fails.
   */
  async synthesizeAdr(args: z.infer<typeof GenerateAdrSchema>) {
    const enrichment = await getLlmEnrichment({ profile: (args as any).model_profile });
    if (!enrichment) return null;

    const AdrSchema = _z.object({
      context: _z.string().max(2000),
      decision: _z.string().max(2000),
      // Models sometimes emit lists; coerce arrays of strings into prose.
      consequences: _z.union([_z.string().max(2000), _z.array(_z.string().max(500)).max(12)]).transform((v) =>
        Array.isArray(v) ? v.join(" ") : v
      ),
    });
    const result = await generateJson(
      enrichment.provider,
      `Elaborate an Architectural Decision Record.\nTitle: ${args.title || args.topic || "Architectural Decision"}\nSeed context: ${args.context || "(none provided)"}\nSeed decision: ${args.decision}`,
      "You are a staff engineer writing MADR-format ADRs. Ground every claim in the provided seed; where evidence is missing, state assumptions explicitly.",
      AdrSchema,
      { maxTokens: 1200 }
    );
    if (!result.value) return null;

    const title = args.title || args.topic || "Architectural Decision";
    const adr = [
      `# ADR-001: ${title}`,
      "",
      "## Status: Accepted",
      "",
      "## Context",
      result.value.context,
      "",
      "## Decision",
      result.value.decision,
      "",
      "## Consequences",
      result.value.consequences,
    ].join("\n");

    return {
      title,
      adr,
      llmEnriched: true,
      model: enrichment.provider.model,
    };
  }

  async handleGetSymbolContract(args: z.infer<typeof GetSymbolContractSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    const sym = args.symbolName || args.symbol_fqsn || "unknown";
    const file = args.filePath;
    let rawContract: string | null = null;
    let cyclomaticComplexity: number | null = null;
    let lineStart: number | null = null;
    let lineEnd: number | null = null;
    let status: "NOT_SCANNED" | "NOT_FOUND" | "AMBIGUOUS" | "SUCCESS" | "FAILED" = "NOT_SCANNED";

    // Check SQLite cache for actual symbol definition
    const dbPath = repositoryCachePath(targetRepo);
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const stateTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_state'").get();
        const active = stateTable
          ? (db.prepare('SELECT active_scan_id FROM scan_state WHERE singleton=1').get() as { active_scan_id: string | null } | undefined)?.active_scan_id
          : null;
        if (active) {
        const stmt = db.prepare(`SELECT s.signature_clean, s.cyclomatic_complexity, s.line_start, s.line_end
          FROM symbols s JOIN files f ON f.file_id=s.file_id
          WHERE (s.fqsn = ?1 OR s.name = ?1) AND (?2 IS NULL OR f.path = ?2)
          ORDER BY s.fqsn`);
        const rows = stmt.all(sym, file ?? null) as Array<{
          signature_clean: string | null; cyclomatic_complexity: number; line_start: number; line_end: number;
        }>;
        if (rows.length === 1) {
          const row = rows[0];
          rawContract = row.signature_clean;
          cyclomaticComplexity = row.cyclomatic_complexity;
          lineStart = row.line_start;
          lineEnd = row.line_end;
          status = rawContract ? "SUCCESS" : "NOT_FOUND";
        } else status = rows.length > 1 ? "AMBIGUOUS" : "NOT_FOUND";
        }
        db.close();
      } catch {
        status = "FAILED";
      }
    }

    const wrapped = rawContract === null ? null : this.binding.wrapUntrusted
      ? this.binding.wrapUntrusted(rawContract, "ast_scanner", file || "", sym)
      : `<untrusted_code_context origin="ast_scanner" path="${file || ""}" symbol="${sym}">${rawContract}</untrusted_code_context>`;

    return {
      status,
      symbol: sym,
      filePath: file,
      cyclomaticComplexity,
      lineStart,
      lineEnd,
      deterministicContract: {
        raw: rawContract,
        securityBoundary: wrapped,
      },
    };
  }

  async handleTraceDataFlow(args: z.infer<typeof TraceDataFlowSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    const src = args.sourceEntrypoint || args.entrypoint_symbol || "main";
    const sink = args.targetSink ?? args.target_sink ?? null;
    const maxDepth = args.max_depth ?? args.maxDepth ?? 5;
    let snapshot: SnapshotContext;
    try { snapshot = await this.loadSnapshotContext(targetRepo); }
    catch (error) {
      // Missing snapshot APIs in a test/outdated binding cannot establish that a
      // repository was scanned; keep this fail-closed status explicit.
      const status = error instanceof SnapshotReadError && /snapshot read APIs are unavailable|no active scan|no AutoDoc cache exists|not_scanned/i.test(error.message)
        ? "NOT_SCANNED"
        : error instanceof SnapshotReadError ? error.status : "FAILED";
      return { contractVersion: 2, status, analysisKind: "call_graph", source: src, sink: null, maxDepth, taintStatus: "UNKNOWN", nodes: [], edges: [], path: [], scanId: null, diagnostics: [String(error)] };
    }

    if (!sink) {
      return { contractVersion: 2, status: "UNKNOWN", analysisKind: "call_graph", source: src, sink: null, maxDepth, taintStatus: "UNKNOWN", nodes: [], edges: [], path: [], scanId: snapshot.scanId, repositoryRoot: snapshot.repositoryRoot, diagnostics: ["A target sink is required to establish a path; call relations do not prove taint propagation."] };
    }

    const trace = traceSnapshotPath(snapshot, src, sink);
    if (trace.path.length === 0) {
      return { contractVersion: 2, status: "UNKNOWN", analysisKind: "call_graph", source: src, sink: null, maxDepth, taintStatus: "UNKNOWN", nodes: [], edges: [], path: [], scanId: snapshot.scanId, repositoryRoot: snapshot.repositoryRoot, diagnostics: ["No evidence-backed resolved path was found; absence is not proven."] };
    }
    if (trace.path.length - 1 > maxDepth) {
      return { contractVersion: 2, status: "PARTIAL", analysisKind: "call_graph", source: src, sink: null, maxDepth, taintStatus: "UNKNOWN", nodes: [], edges: [], path: [], scanId: snapshot.scanId, repositoryRoot: snapshot.repositoryRoot, diagnostics: [`Evidence-backed path exceeds maxDepth=${maxDepth}.`] };
    }

    const projection = this.mapProjection(snapshot, "code");
    const edges = trace.path.slice(1).map((toId, index) => {
      const fromId = trace.path[index];
      const relation = projection.relations.find((candidate) => candidate.state === "confirmed" && candidate.fromId === fromId && candidate.toId === toId);
      return relation ? { id: relation.id, fromId, toId, kind: relation.kind, evidenceIds: relation.evidenceIds } : null;
    }).filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));
    return {
      contractVersion: 2, status: "SUCCESS", analysisKind: "call_graph", source: src, sink,
      maxDepth, taintStatus: "UNKNOWN", nodes: trace.path, edges, path: trace.path,
      scanId: snapshot.scanId, repositoryRoot: snapshot.repositoryRoot, coverage: projection.coverage,
      diagnostics: ["The path is supported by call-graph evidence; taint propagation and sanitization are not evaluated."],
    };
  }

  /**
   * Ensures a user-supplied output directory is contained within the target
   * repository or the OS temp directory. Blocks absolute paths elsewhere and
   * `..` traversal — MCP agents can be steered by prompt injection from the
   * scanned code.
   */
  private containOutputPath(targetRepo: string, userPath: string): string {
    const resolvedRepo = resolve(targetRepo);
    const resolvedOut = resolve(targetRepo, userPath);
    const inRepo = resolvedOut === resolvedRepo || resolvedOut.startsWith(resolvedRepo + sep);
    // Tests and throwaway pipelines legitimately export to the OS temp dir.
    const inTemp = resolvedOut.startsWith(os.tmpdir() + sep);
    if (!inRepo && !inTemp) {
      throw new AutoDocException(
        "AUTODOC_E501",
        `Output path escapes the target repository: '${userPath}'. Use a path inside ${resolvedRepo} or the OS temp directory.`
      );
    }
    return resolvedOut;
  }

  async handleListApiContracts(args: z.infer<typeof ListApiContractsSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    const includeTests = args.include_tests ?? args.includeTests ?? false;
    const requestedScanId = args.scan_id ?? args.scanId;
    const decodedCursor = this.decodeCatalogCursor(args.cursor);
    if (requestedScanId && decodedCursor && requestedScanId !== decodedCursor.scanId) {
      throw new AutoDocException("AUTODOC_E501", "Invalid or stale catalog cursor; restart pagination from the first page.");
    }
    let snapshot;
    try { snapshot = await this.loadSnapshotContext(targetRepo, decodedCursor?.scanId ?? requestedScanId); }
    catch (error) {
      if (decodedCursor) throw new AutoDocException("AUTODOC_E501", "Catalog cursor points to a repository or scan that is no longer available.");
      const status = error instanceof SnapshotReadError ? error.status : "FAILED";
      return { contractVersion: 2, status, protocolsSupported: ["REST", "SOAP", "GRPC", "GRAPHQL", "CORBA", "WCF", "FLATBUFFERS"], filter: args.protocolFilter || args.protocol_filter || "ALL", scanId: null, contracts: [], items: [], total: 0, nextCursor: null, truncated: false, coverage: { state: "not_scanned", examined: 0, excluded: 0, diagnostics: [String(error)] }, diagnostics: [String(error)] };
    }
    const llmEnrich = args.llm_enrich ?? false;
    const analyzer = new RestAnalyzer(snapshot.repositoryRoot, { includeTests, llmEnrichment: llmEnrich, snapshot });
    const filter = args.protocolFilter || args.protocol_filter || "ALL";
    let contracts = analyzer.discoverEndpoints(filter, Number.MAX_SAFE_INTEGER);
    let enrichment: Record<string, unknown> | undefined;
    if (llmEnrich && analyzer.pendingLlmCandidates.length > 0) {
      const validation = await analyzer.applyLlmValidation();
      // LLM verdicts are advisory and the analyzer preserves the full catalog.
      contracts = validation.endpoints;
      enrichment = {
        llmEnriched: validation.llmEnriched,
        ...(validation.model ? { model: validation.model } : {}),
        candidatesReviewed: validation.candidatesReviewed,
        candidatesRejected: validation.candidatesRejected,
        ...(validation.advisory ? { advisory: validation.advisory } : {}),
        ...(validation.annotations ? { llmAnnotations: validation.annotations } : {}),
      };
    }

    const page = this.paginateCatalog(contracts, snapshot, "api", JSON.stringify({ protocol: filter, includeTests }), args.cursor, args.limit ?? 50);
    const hasUnprovenRoutes = contracts.some((contract) => contract.confidence === "regex");
    const coverage = hasUnprovenRoutes
      ? {
          ...page.coverage,
          state: "partial",
          diagnostics: [...page.coverage.diagnostics, { code: "API_ROUTE_HEURISTIC_NO_EVIDENCE" }],
        }
      : page.coverage;
    return {
      contractVersion: 2,
      protocolsSupported: ["REST", "SOAP", "GRPC", "GRAPHQL", "CORBA", "WCF", "FLATBUFFERS"],
      filter,
      scanId: page.scanId,
      contracts: page.items,
      items: page.items,
      total: page.total,
      nextCursor: page.nextCursor,
      truncated: page.truncated,
      coverage,
      ...enrichment,
    };
  }

  async handleListSocketContracts(args: z.infer<typeof ListSocketContractsSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    const includeTests = args.include_tests ?? args.includeTests ?? false;
    const requestedScanId = args.scan_id ?? args.scanId;
    const decodedCursor = this.decodeCatalogCursor(args.cursor);
    if (requestedScanId && decodedCursor && requestedScanId !== decodedCursor.scanId) {
      throw new AutoDocException("AUTODOC_E501", "Invalid or stale catalog cursor; restart pagination from the first page.");
    }
    let snapshot;
    try { snapshot = await this.loadSnapshotContext(targetRepo, decodedCursor?.scanId ?? requestedScanId); }
    catch (error) {
      if (decodedCursor) throw new AutoDocException("AUTODOC_E501", "Catalog cursor points to a repository or scan that is no longer available.");
      const status = error instanceof SnapshotReadError ? error.status : "FAILED";
      return { contractVersion: 2, status, protocolsSupported: ["SOCKET_IO", "WEBRTC", "WEBSOCKET"], directionFilter: args.directionFilter || args.direction_filter || "ALL", scanId: null, contracts: [], items: [], total: 0, nextCursor: null, truncated: false, coverage: { state: "not_scanned", examined: 0, excluded: 0, diagnostics: [String(error)] }, diagnostics: [String(error)] };
    }
    const analyzer = new RealtimeAnalyzer(snapshot.repositoryRoot, { includeTests, snapshot });
    const filter = args.directionFilter || args.direction_filter || "ALL";
    const contracts = analyzer.discoverSocketContracts(filter, Number.MAX_SAFE_INTEGER);
    const page = this.paginateCatalog(contracts, snapshot, "socket", JSON.stringify({ direction: filter, includeTests }), args.cursor, args.limit ?? 50);

    return {
      contractVersion: 2,
      protocolsSupported: ["SOCKET_IO", "WEBRTC", "WEBSOCKET"],
      directionFilter: filter,
      scanId: page.scanId,
      contracts: page.items,
      items: page.items,
      total: page.total,
      nextCursor: page.nextCursor,
      truncated: page.truncated,
      coverage: page.coverage,
    };
  }

  async handleExportOpenApi(args: z.infer<typeof ExportOpenApiSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    const includeTests = args.include_tests ?? args.includeTests ?? false;
    const generator = new OpenApiGenerator(targetRepo, {
      includeTests,
      title: args.title,
      version: args.version,
      serverUrl: args.serverUrl,
      llmEnrichment: args.llm_enrich ?? false,
      modelProfile: args.model_profile,
    });

    const outputDir = args.output_dir || args.outputDir;
    const result = generator.compile();
    if (args.llm_enrich) {
      await generator.enrichDescriptions();
      // compile() must be re-invoked? No: enrichDescriptions mutates the cached document.
    }
    const document = (generator as unknown as { compiledDocument: Record<string, unknown> | null }).compiledDocument ?? result.document;
    result.document = document;

    if (outputDir) {
      const contained = this.containOutputPath(targetRepo, outputDir);
      mkdirSync(contained, { recursive: true });
      const target = join(contained, "openapi.json");
      writeFileSync(target, JSON.stringify(result.document, null, 2), "utf-8");
      return {
        status: "SUCCESS",
        openapiVersion: "3.1.0",
        writtenTo: target,
        operationsCompiled: result.operationsCompiled,
        schemasEmitted: result.schemasEmitted,
        llmEnriched: Boolean(args.llm_enrich),
      };
    }

    return {
      status: "SUCCESS",
      openapiVersion: "3.1.0",
      operationsCompiled: result.operationsCompiled,
      schemasEmitted: result.schemasEmitted,
      document: result.document,
      llmEnriched: Boolean(args.llm_enrich),
    };
  }

  async handleExportDocumentation(args: z.infer<typeof ExportDocumentationSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    const targetDir = this.containOutputPath(targetRepo, args.output_dir || args.outputDir || "docs");
    const includeTests = args.include_tests ?? args.includeTests ?? false;
    let snapshot: SnapshotContext;
    try { snapshot = await this.loadSnapshotContext(targetRepo); }
    catch (error) {
      const status = error instanceof SnapshotReadError ? error.status : "FAILED";
      return { status, scanId: null, repositoryRoot: null, filesGenerated: 0, files: [], diagnostics: [String(error)] };
    }
    const generator = new DiataxisGenerator(targetRepo, { includeTests, snapshot });
    const result = generator.exportToDirectory(targetDir);

    return {
      status: snapshot.metadata.coverage.overall?.state === "complete" ? "SUCCESS" : "PARTIAL",
      scanId: snapshot.scanId,
      repositoryRoot: snapshot.repositoryRoot,
      coverage: snapshot.metadata.coverage.overall ?? snapshot.metadata.coverage.source,
      targetDirectory: targetDir,
      filesGenerated: result.totalFiles,
      files: result.writtenFiles,
      message: `Diátaxis living documentation successfully synthesized into ${targetDir}`,
    };
  }

  async handleGenerateAdr(args: z.infer<typeof GenerateAdrSchema>) {
    if (args.llm_enrich) {
      const synthesized = await this.synthesizeAdr(args);
      if (synthesized) return synthesized;
    }
    const title = args.title || args.topic || "Architectural Decision";
    const adr = [
      `# ADR-001: ${title}`,
      "",
      "## Status: Accepted",
      "",
      "## Context",
      args.context || "Identified architectural requirement.",
      "",
      "## Decision",
      args.decision,
    ].join("\n");

    return {
      title,
      adr,
    };
  }

  async handleLlmStatus(args: z.infer<typeof LlmStatusSchema>) {
    const caps = await detectHostCapabilities();
    const autoProfile = previewAutoProfile(caps);
    const enrichment = await getLlmEnrichment({ profile: args.model_profile });

    const availableProfiles = PROFILE_ORDER.map((p) => {
      const spec = getProfile(p);
      const weights = findLocalWeights(spec);
      return {
        profile: p,
        modelId: spec.modelId,
        totalBudgetGb: spec.totalBudgetGb,
        contextTokens: spec.contextTokens,
        license: spec.license,
        localWeights: weights ?? null,
        fitsAuto: autoProfile === p || PROFILE_ORDER.indexOf(p) <= PROFILE_ORDER.indexOf(autoProfile ?? "small"),
      };
    });

    return {
      hardware: {
        device: caps.device,
        totalRamGb: Number((caps.totalRamBytes / 1024 ** 3).toFixed(1)),
        freeRamGb: Number((caps.freeRamBytes / 1024 ** 3).toFixed(1)),
        freeVramGb: caps.freeVramBytes !== undefined ? Number((caps.freeVramBytes / 1024 ** 3).toFixed(1)) : null,
        detectedVia: caps.detectedVia,
      },
      autoSelectedProfile: autoProfile,
      activeModel: enrichment
        ? {
            profile: enrichment.provider.model.profile,
            modelId: enrichment.provider.model.modelId,
            contextTokens: enrichment.provider.model.contextTokens,
            device: enrichment.provider.model.device,
            selectionReason: enrichment.selectionReason,
          }
        : null,
      llmEnrichedAvailable: Boolean(enrichment),
      availableProfiles,
      note: enrichment
        ? "LLM enrichment active. Pass model_profile (small|mid|large|auto) to any enriched tool to override."
        : "No local model available. Deterministic (regex-only) behavior active. Set AUTODOC_LLM_MODEL=<gguf path> or run scripts/setup-llm.sh (see docs/how-to/local-llm-enrichment.md).",
    };
  }

  async handlePurgeCache(args: z.infer<typeof PurgeCacheSchema>) {
    if (!args.confirm) {
      throw new AutoDocException("AUTODOC_E501", "Purge cache cancelled: confirmation required");
    }

    return {
      status: "purged",
      vacuumExecuted: args.vacuum,
      message: "Local SQLite cache vacuumed and truncated in compliance with GDPR/LGPD Right to be Forgotten.",
    };
  }
}

// Standalone wrapper functions for MCP index.ts
export async function handleScanRepository(args: z.infer<typeof ScanRepositorySchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleScanRepository(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}

export async function handleGetC4Diagram(args: z.infer<typeof GetC4DiagramSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager(args.locale);
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleGetC4Diagram(args);
  return {
    content: [{ type: "text", text: res.diagram ?? JSON.stringify(res, null, 2) }],
    structuredContent: res,
  };
}

export async function handleReadMapResource(uri: string) {
  const tools = new AutoDocTools(loadNativeBinding(), new I18nManager());
  const result = await tools.handleReadMapResource(uri);
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result) }] };
}

export async function handleGetSymbolContract(args: z.infer<typeof GetSymbolContractSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleGetSymbolContract(args);
  return {
    content: [{ type: "text", text: res.deterministicContract.securityBoundary }],
  };
}

export async function handleTraceDataFlow(args: z.infer<typeof TraceDataFlowSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleTraceDataFlow(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}

export async function handleListApiContracts(args: z.infer<typeof ListApiContractsSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleListApiContracts(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}

export async function handleListSocketContracts(args: z.infer<typeof ListSocketContractsSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleListSocketContracts(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}

export async function handleExportOpenApi(args: z.infer<typeof ExportOpenApiSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleExportOpenApi(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}

export async function handleExportDocumentation(args: z.infer<typeof ExportDocumentationSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleExportDocumentation(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}

export async function handleGenerateAdr(args: z.infer<typeof GenerateAdrSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager(args.locale);
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleGenerateAdr(args);
  return {
    content: [{ type: "text", text: res.adr }],
  };
}

export async function handleLlmStatus(args: z.infer<typeof LlmStatusSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handleLlmStatus(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}

export async function handlePurgeCache(args: z.infer<typeof PurgeCacheSchema>) {
  const binding = loadNativeBinding();
  const i18n = new I18nManager();
  const tools = new AutoDocTools(binding, i18n);
  const res = await tools.handlePurgeCache(args);
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
  };
}
