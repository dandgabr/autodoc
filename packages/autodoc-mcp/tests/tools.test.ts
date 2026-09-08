import { describe, it, expect, beforeAll } from "vitest";
import { AutoDocTools } from "../src/tools/handlers.js";
import { loadNativeBinding } from "../src/binding.js";
import { I18nManager } from "../src/i18n/index.js";
import path from "node:path";

describe("AutoDoc MCP Tools Handlers & Schemas", () => {
  let tools: AutoDocTools;
  const repoRoot = path.resolve(process.cwd(), "../..");

  beforeAll(() => {
    const binding = loadNativeBinding();
    const i18n = new I18nManager("en-US");
    tools = new AutoDocTools(binding, i18n);
  });

  it("should have schemas for all 7 registered MCP tools", () => {
    const definitions = tools.getToolDefinitions();
    expect(definitions.length).toBe(7);

    const names = definitions.map((d) => d.name);
    expect(names).toContain("autodoc_scan_repository");
    expect(names).toContain("autodoc_get_c4_diagram");
    expect(names).toContain("autodoc_get_symbol_contract");
    expect(names).toContain("autodoc_trace_data_flow");
    expect(names).toContain("autodoc_list_api_contracts");
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
    expect(res.diagram).toContain("flowchart TB");
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

  it("should execute autodoc_get_symbol_contract with prompt-shielded response", async () => {
    const res = await tools.handleGetSymbolContract({
      symbolName: "scan_repository",
      filePath: "crates/autodoc-core/src/scanner.rs"
    });

    expect(res).toBeDefined();
    expect(res.symbol).toBe("scan_repository");
    expect(res.deterministicContract).toBeDefined();
    expect(res.deterministicContract.securityBoundary).toContain("<untrusted_code_context");
  });

  it("should execute autodoc_trace_data_flow", async () => {
    const res = await tools.handleTraceDataFlow({
      sourceEntrypoint: "handleScanRepository",
      targetSink: "sqlite_edges",
      maxDepth: 5
    });

    expect(res).toBeDefined();
    expect(res.source).toBe("handleScanRepository");
    expect(res.path.length).toBeGreaterThan(0);
  });

  it("should execute autodoc_list_api_contracts", async () => {
    const res = await tools.handleListApiContracts({
      protocolFilter: "all"
    });

    expect(res).toBeDefined();
    expect(res.protocolsSupported).toBeDefined();
    expect(res.protocolsSupported.length).toBeGreaterThanOrEqual(7);
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
