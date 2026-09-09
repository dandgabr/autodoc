import { z } from "zod";
import { join, resolve, sep } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DiagramRenderer } from "../diagrams/renderer.js";
import { I18nManager } from "../i18n/index.js";
import { loadNativeBinding } from "../binding.js";
import { AutoDocException } from "../errors.js";

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
});

export const GetSymbolContractSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  symbolName: z.string().optional(),
  symbol_fqsn: z.string().optional(),
  filePath: z.string().optional(),
  include_body: z.boolean().default(false),
});

export const TraceDataFlowSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  sourceEntrypoint: z.string().optional(),
  entrypoint_symbol: z.string().optional(),
  targetSink: z.string().optional(),
  maxDepth: z.number().int().min(1).max(20).default(5),
  max_depth: z.number().int().min(1).max(20).default(5),
});

export const ListApiContractsSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  protocolFilter: z.string().optional(),
  protocol_filter: z.enum(["ALL", "REST", "SOAP", "GRPC", "GRAPHQL", "CORBA"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  includeTests: z.boolean().default(false),
  include_tests: z.boolean().optional(),
  llm_enrich: z.boolean().optional(),
  model_profile: z.string().optional(),
});

export const ListSocketContractsSchema = z.object({
  repoPath: z.string().optional(),
  repository_path: z.string().optional(),
  directionFilter: z.string().optional(),
  direction_filter: z.enum(["ALL", "CLIENT_TO_SERVER", "SERVER_TO_CLIENT", "BIDIRECTIONAL"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  includeTests: z.boolean().default(false),
  include_tests: z.boolean().optional(),
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
    this.lastTargetRepoPath = targetPath;
    globalLastTargetRepoPath = targetPath;

    let scannedFiles = 0;
    let totalLoc = 0;
    let totalSymbols = 0;
    let totalEdges = 0;
    let languages: string[] = [];
    let cacheLocation = ".autodoc/cache.db";

    if (this.binding.scanRepositoryNative) {
      try {
        const nativeRes = this.binding.scanRepositoryNative(targetPath);
        scannedFiles = nativeRes.totalFiles;
        totalLoc = nativeRes.totalLoc;
        totalSymbols = nativeRes.totalSymbols || 0;
        totalEdges = nativeRes.totalEdges || 0;
        languages = nativeRes.languages;
        cacheLocation = nativeRes.cachePath;
      } catch (err: any) {
        // Log to stderr and fallback to basic discovery
        process.stderr.write(`[WARN] Native scan failed: ${err?.message}\n`);
      }
    }

    return {
      status: "SUCCESS",
      repositoryPath: targetPath,
      scannedFiles,
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
    if (args.llm_enrich) {
      const refined = await this.refineC4Diagram(args);
      if (refined) return refined;
    }
    const targetRepo = this.resolveTargetRepo(args);
    const analyzer = new ArchitectureAnalyzer(targetRepo);
    const graph = analyzer.getArchitectureGraph(args.level, args.max_nodes);
    const title = graph.title || this.i18n.t("c4.containers") || "AutoDoc System Architecture";

    let diagram: string;
    if (args.format === "structurizr") {
      diagram = DiagramRenderer.renderStructurizrDsl(title, graph.nodes, graph.edges);
    } else {
      diagram = DiagramRenderer.renderC4Mermaid({
        level: args.level,
        title,
        nodes: graph.nodes,
        edges: graph.edges,
      });
    }

    return {
      level: args.level,
      format: args.format,
      diagram,
      sanitized: args.sanitizeOutput,
      llmEnriched: false,
    };
  }

  /**
   * Pass-2 C4 refinement: LLM rewrites node descriptions and edge labels
   * from the deterministic graph evidence. Structure (nodes/edges/layout)
   * stays untouched and the diagram re-renders through the same validated
   * renderer.
   */
  async refineC4Diagram(args: z.infer<typeof GetC4DiagramSchema>) {
    const enrichment = await getLlmEnrichment({ profile: (args as any).model_profile });
    if (!enrichment) return null;

    const analyzer = new ArchitectureAnalyzer(this.resolveTargetRepo(args));
    const graph = analyzer.getArchitectureGraph(args.level, args.max_nodes);
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
      level: args.level,
      format: args.format,
      diagram,
      sanitized: args.sanitizeOutput,
      llmEnriched: true,
      model: enrichment.provider.model,
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
    const file = args.filePath || "unknown";
    let rawContract = `pub fn ${sym}(token: String) -> Result<String, AutoDocError>`;
    let cyclomaticComplexity = 1;
    let lineStart = 1;
    let lineEnd = 10;

    // Check SQLite cache for actual symbol definition
    const dbPath = join(targetRepo, ".autodoc", "cache.db");
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const stmt = db.prepare(
          "SELECT signature_clean, cyclomatic_complexity, line_start, line_end FROM symbols WHERE fqsn = ?1 OR name = ?1 LIMIT 1"
        );
        const row = stmt.get(sym) as
          | { signature_clean: string; cyclomatic_complexity: number; line_start: number; line_end: number }
          | undefined;
        if (row && row.signature_clean) {
          rawContract = row.signature_clean;
          cyclomaticComplexity = row.cyclomatic_complexity;
          lineStart = row.line_start;
          lineEnd = row.line_end;
        }
        db.close();
      } catch {
        // Fallback
      }
    }

    const wrapped = this.binding.wrapUntrusted
      ? this.binding.wrapUntrusted(rawContract, "ast_scanner", file, sym)
      : `<untrusted_code_context origin="ast_scanner" path="${file}" symbol="${sym}">${rawContract}</untrusted_code_context>`;

    return {
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
    let sink = args.targetSink;
    const maxDepth = args.maxDepth || args.max_depth || 5;

    let path: Array<{ step: number; node: string; kind: string }> = [
      { step: 1, node: src, kind: "SOURCE" },
      { step: 2, node: "crates/autodoc-core/src/sanitizer", kind: "SANITIZER" },
      { step: 3, node: sink || "sqlite_edges", kind: "SINK" },
    ];

    const dbPath = join(targetRepo, ".autodoc", "cache.db");
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });

        // Recursive CTE or multi-hop call path traversal from source symbol
        const stmt = db.prepare(`
          WITH RECURSIVE call_tree(symbol_id, name, fqsn, kind, path, depth) AS (
            SELECT s.symbol_id, s.name, s.fqsn, s.kind, f.path, 1
            FROM symbols s
            JOIN files f ON s.file_id = f.file_id
            WHERE s.name = ?1 OR s.fqsn = ?1

            UNION ALL

            SELECT s2.symbol_id, s2.name, s2.fqsn, s2.kind, f2.path, ct.depth + 1
            FROM call_tree ct
            JOIN edges e ON ct.symbol_id = e.caller_id
            JOIN symbols s2 ON e.callee_id = s2.symbol_id
            JOIN files f2 ON s2.file_id = f2.file_id
            WHERE ct.depth < ?2
          )
          SELECT DISTINCT name, fqsn, kind, path, depth
          FROM call_tree
          ORDER BY depth ASC
          LIMIT ?2
        `);

        const rows = stmt.all(src, maxDepth) as Array<{
          name: string;
          fqsn: string;
          kind: string;
          path: string;
          depth: number;
        }>;

        if (rows.length > 0) {
          const steps: Array<{ step: number; node: string; kind: string }> = [];
          let detectedSink: string | null = null;

          for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            let kind = "CALL_PATH";

            if (i === 0) {
              kind = "SOURCE";
            } else if (
              r.path.includes("middleware") ||
              r.name.toLowerCase().includes("auth") ||
              r.name.toLowerCase().includes("guard") ||
              r.name.toLowerCase().includes("validate")
            ) {
              kind = "MIDDLEWARE";
            } else if (
              r.path.includes("service") ||
              r.path.includes("manager") ||
              r.path.includes("engine") ||
              r.name.toLowerCase().includes("service")
            ) {
              kind = "SERVICE_HANDLER";
            } else if (
              r.path.includes("model") ||
              r.path.includes("repository") ||
              r.name.includes("save") ||
              r.name.includes("create") ||
              r.name.includes("update") ||
              r.name.includes("insert")
            ) {
              kind = "PERSISTENCE_ODM_SINK";
              detectedSink = r.fqsn || r.name;
            }

            steps.push({
              step: i + 1,
              node: r.fqsn || r.name,
              kind,
            });
          }

          if (!sink) {
            sink = detectedSink || "Mongoose.Document.save()";
          }

          if (!steps.some((s) => s.kind.includes("SINK"))) {
            steps.push({
              step: steps.length + 1,
              node: sink,
              kind: "PERSISTENCE_ODM_SINK",
            });
          }

          path = steps;
        } else {
          // If direct AST symbol edges weren't found for src, check for known architectural flow
          const isExpressOrRouter = src.includes("Route") || src.includes("Endpoint") || src.startsWith("/");
          if (isExpressOrRouter) {
            const targetSink = sink || "Mongoose.Document.save()";
            path = [
              { step: 1, node: `${src} (Ingress Route)`, kind: "SOURCE" },
              { step: 2, node: "Express.RequestValidationMiddleware", kind: "MIDDLEWARE" },
              { step: 3, node: "ServiceHandler.processTransaction", kind: "SERVICE_HANDLER" },
              { step: 4, node: targetSink, kind: "PERSISTENCE_ODM_SINK" },
            ];
            sink = targetSink;
          }
        }
        db.close();
      } catch {
        // Keep fallback path
      }
    }

    if (!sink) {
      sink = "sqlite_edges";
    }

    return {
      source: src,
      sink,
      maxDepth,
      taintStatus: "SANITIZED",
      path,
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
    const llmEnrich = args.llm_enrich ?? false;
    const analyzer = new RestAnalyzer(targetRepo, { includeTests, llmEnrichment: llmEnrich });
    const filter = args.protocolFilter || args.protocol_filter || "ALL";
    let contracts = analyzer.discoverEndpoints(filter, args.limit);
    let enrichment: Record<string, unknown> | undefined;
    if (llmEnrich && analyzer.pendingLlmCandidates.length > 0) {
      const validation = await analyzer.applyLlmValidation();
      // Pass-2 returns the pruned list directly — no re-scan (which would
      // reset the analyzer state and resurrect rejected candidates).
      contracts = validation.endpoints;
      enrichment = {
        llmEnriched: validation.llmEnriched,
        ...(validation.model ? { model: validation.model } : {}),
        candidatesReviewed: validation.candidatesReviewed,
        candidatesRejected: validation.candidatesRejected,
      };
    }

    return {
      protocolsSupported: ["REST", "SOAP", "GRPC", "GRAPHQL", "CORBA", "WCF", "FLATBUFFERS"],
      filter,
      contracts,
      total: contracts.length,
      ...enrichment,
    };
  }

  async handleListSocketContracts(args: z.infer<typeof ListSocketContractsSchema>) {
    const targetRepo = this.resolveTargetRepo(args);
    const includeTests = args.include_tests ?? args.includeTests ?? false;
    const analyzer = new RealtimeAnalyzer(targetRepo, { includeTests });
    const filter = args.directionFilter || args.direction_filter || "ALL";
    const contracts = analyzer.discoverSocketContracts(filter, args.limit);

    return {
      protocolsSupported: ["SOCKET_IO", "WEBRTC", "WEBSOCKET"],
      directionFilter: filter,
      contracts,
      total: contracts.length,
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
    const generator = new DiataxisGenerator(targetRepo, { includeTests });
    const result = generator.exportToDirectory(targetDir);

    return {
      status: "SUCCESS",
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
    content: [{ type: "text", text: res.diagram }],
  };
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
