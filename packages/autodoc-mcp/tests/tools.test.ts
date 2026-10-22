import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AutoDocTools } from "../src/tools/handlers.js";
import { loadNativeBinding } from "../src/binding.js";
import { I18nManager } from "../src/i18n/index.js";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import fs from "node:fs";

describe("AutoDoc MCP Tools Handlers & Schemas", () => {
  let tools: AutoDocTools;
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "autodoc-tools-repo-"));
    fs.writeFileSync(path.join(repoRoot, "scanner.rs"), "pub fn scan_repository() { helper(); }\nfn helper() {}\n");
    fs.writeFileSync(path.join(repoRoot, "app.js"), "app.get('/api/health', handler);\nsocket.on('ping', handler);\n");
    fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "vitest" } }));
    fs.writeFileSync(path.join(repoRoot, "Dockerfile"), "FROM node:22\nCMD [\"node\", \"app.js\"]\n");
    const binding = loadNativeBinding();
    const i18n = new I18nManager("en-US");
    tools = new AutoDocTools(binding, i18n);
  });
  afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));

  it("should have schemas for all registered MCP tools", () => {
    const definitions = tools.getToolDefinitions();
    expect(definitions.length).toBe(11);

    const names = definitions.map((d) => d.name);
    expect(names).toContain("autodoc_scan_repository");
    expect(names).toContain("autodoc_get_c4_diagram");
    expect(names).toContain("autodoc_get_symbol_contract");
    expect(names).toContain("autodoc_trace_data_flow");
    expect(names).toContain("autodoc_list_api_contracts");
    expect(names).toContain("autodoc_list_socket_contracts");
    expect(names).toContain("autodoc_export_openapi");
    expect(names).toContain("autodoc_llm_status");
    expect(names).toContain("autodoc_export_documentation");
    expect(names).toContain("autodoc_generate_adr");
    expect(names).toContain("autodoc_purge_cache");
  });

  it("should execute autodoc_scan_repository successfully", async () => {
    const res = await tools.handleScanRepository({
      repoPath: repoRoot,
      deepScan: false,
      enablePiiScrubbing: true
    });

    expect(res).toBeDefined();
    expect(res.scannedFiles).toBeGreaterThan(0);
    expect(res.engine).toBe("NAPI-RS / Rayon");
    expect(res.piiScrubbed).toBe(true);
  });

  it("should execute autodoc_get_c4_diagram with sanitized Mermaid output", async () => {
    const res = await tools.handleGetC4Diagram({
      level: 1,
      format: "mermaid",
      sanitizeOutput: true
    });

    expect(res).toBeDefined();
    expect(res.level).toBe(1);
    expect(res.format).toBe("mermaid");
    expect(res.diagram).toContain("C4Context");
    expect(res.sanitized).toBe(true);
  });

  it("should execute autodoc_get_c4_diagram with Structurizr DSL output", async () => {
    const res = await tools.handleGetC4Diagram({
      level: 2,
      format: "structurizr",
      sanitizeOutput: true
    });

    expect(res).toBeDefined();
    expect(res.format).toBe("structurizr");
    expect(res.diagram).toContain('workspace');
  });

  it("does not fabricate a symbol contract when the legacy cache has no projected signature", async () => {
    const res = await tools.handleGetSymbolContract({
      symbolName: "scan_repository",
      filePath: "scanner.rs",
      repoPath: repoRoot,
    });

    expect(res).toBeDefined();
    expect(res.symbol).toBe("scan_repository");
    expect(res.deterministicContract).toEqual({ raw: null, securityBoundary: null });
  });

  it("should execute autodoc_trace_data_flow", async () => {
    const emptyRepo = mkdtempSync(path.join(tmpdir(), "autodoc-tools-empty-"));
    const res = await tools.handleTraceDataFlow({
      repoPath: emptyRepo,
      sourceEntrypoint: "handleScanRepository",
      targetSink: "sqlite_edges",
      maxDepth: 5
    });

    expect(res).toBeDefined();
    expect(res.source).toBe("handleScanRepository");
    expect(res.status).toBe("NOT_SCANNED");
    expect(res.path).toEqual([]);
    expect(res.taintStatus).toBe("UNKNOWN");

    // Test async route ingress flow
    const routeFlow = await tools.handleTraceDataFlow({
      repoPath: emptyRepo,
      sourceEntrypoint: "/api/users/profile",
      maxDepth: 5
    });
    expect(routeFlow).toBeDefined();
    expect(routeFlow.path).toEqual([]);
    expect(routeFlow.sink).toBeNull();
    expect(routeFlow.taintStatus).toBe("UNKNOWN");
    rmSync(emptyRepo, { recursive: true, force: true });
  });

  it("should execute autodoc_list_api_contracts", async () => {
    const catalogRepo = mkdtempSync(path.join(tmpdir(), "autodoc-api-fixture-"));
    fs.writeFileSync(path.join(catalogRepo, "app.js"), "app.get('/api/health', handler);\n");
    await tools.handleScanRepository({ repoPath: catalogRepo });
    const res = await tools.handleListApiContracts({
      protocolFilter: "ALL",
      repoPath: catalogRepo,
    });

    expect(res).toBeDefined();
    expect(res.protocolsSupported).toBeDefined();
    expect(res.protocolsSupported.length).toBeGreaterThanOrEqual(7);
    expect(res.contracts.length).toBeGreaterThan(0);
    rmSync(catalogRepo, { recursive: true, force: true });
  });

  it("should execute autodoc_list_socket_contracts", async () => {
    const catalogRepo = mkdtempSync(path.join(tmpdir(), "autodoc-socket-fixture-"));
    fs.writeFileSync(path.join(catalogRepo, "app.js"), "socket.on('ping', handler);\n");
    await tools.handleScanRepository({ repoPath: catalogRepo });
    const res = await tools.handleListSocketContracts({
      directionFilter: "ALL",
      limit: 50,
      repoPath: catalogRepo,
    });

    expect(res).toBeDefined();
    expect(res.protocolsSupported).toContain("SOCKET_IO");
    expect(res.contracts.length).toBeGreaterThan(0);
    rmSync(catalogRepo, { recursive: true, force: true });
  });

  it("should execute autodoc_export_documentation", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "autodoc-export-test-"));
    const res = await tools.handleExportDocumentation({
      outputDir,
      repoPath: repoRoot,
    });

    expect(res).toBeDefined();
    expect(res.status).toBe("SUCCESS");
    expect(res.filesGenerated).toBeGreaterThan(0);
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("should execute autodoc_generate_adr", async () => {
    const res = await tools.handleGenerateAdr({
      title: "Hybrid NAPI-RS Architecture",
      context: "Need ultra-low memory (<100MB) and multi-threaded AST performance.",
      decision: "Adopt Rust core via NAPI-RS with TypeScript MCP wrapper."
    });

    expect(res).toBeDefined();
    expect(res.adr).toContain("# ADR-");
    expect(res.adr).toContain("## Status: Accepted");
    expect(res.adr).toContain("Hybrid NAPI-RS Architecture");
  });

  it("should execute autodoc_purge_cache", async () => {
    const res = await tools.handlePurgeCache({
      confirm: true,
      vacuum: true,
    });

    expect(res).toBeDefined();
    expect(res.status).toBe("purged");
    expect(res.vacuumExecuted).toBe(true);
  });
});
