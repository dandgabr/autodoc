import { describe, it, expect, beforeAll } from "vitest";
import { AutoDocTools } from "../src/tools/handlers.js";
import { loadNativeBinding } from "../src/binding.js";
import { I18nManager } from "../src/i18n/index.js";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

describe("AutoDoc E2E System Integration Test", () => {
  let tools: AutoDocTools;
  const repoRoot = path.resolve(__dirname, "../../..");
  const cliPath = path.resolve(__dirname, "../dist/index.js");

  beforeAll(() => {
    const binding = loadNativeBinding();
    const i18n = new I18nManager("en-US");
    tools = new AutoDocTools(binding, i18n);
  });

  it("Step 1: should scan repository using native Rayon scanner and report metrics", async () => {
    const scanResult = await tools.handleScanRepository({
      repoPath: repoRoot,
      deepScan: true,
      enablePiiScrubbing: true,
    });

    expect(scanResult).toBeDefined();
    expect(scanResult.status).toBe("SUCCESS");
    expect(scanResult.scannedFiles).toBeGreaterThan(0);
    expect(scanResult.piiScrubbed).toBe(true);
    expect(scanResult.cacheLocation).toBe(".autodoc/cache.db");
  });

  it("Step 2: should generate C4 Level 1 and Level 2 diagrams without XSS vulnerabilities", async () => {
    const level1 = await tools.handleGetC4Diagram({
      level: 1,
      format: "mermaid",
      sanitizeOutput: true,
    });
    expect(level1.diagram).toContain("flowchart TB");
    expect(level1.diagram).not.toContain("<script>");

    const level2Dsl = await tools.handleGetC4Diagram({
      level: 2,
      format: "structurizr",
      sanitizeOutput: true,
    });
    expect(level2Dsl.diagram).toContain("workspace");
    expect(level2Dsl.diagram).toContain("model");
  });

  it("Step 3: should extract symbol contract wrapped in semantic prompt defense boundary", async () => {
    const contract = await tools.handleGetSymbolContract({
      symbolName: "scan_repository",
      filePath: "crates/autodoc-core/src/scanner.rs",
    });

    expect(contract.symbol).toBe("scan_repository");
    expect(contract.deterministicContract.securityBoundary).toContain("<untrusted_code_context");
    expect(contract.deterministicContract.securityBoundary).toContain("origin=\"ast_scanner\"");
  });

  it("Step 4: should trace data flow across architectural boundaries", async () => {
    const flow = await tools.handleTraceDataFlow({
      sourceEntrypoint: "handleScanRepository",
      targetSink: "sqlite_edges",
      maxDepth: 5,
    });

    expect(flow.source).toBe("handleScanRepository");
    expect(flow.sink).toBe("sqlite_edges");
    expect(flow.taintStatus).toBe("SANITIZED");
    expect(flow.path.length).toBe(3);
  });

  it("Step 5: should catalog multi-decade enterprise API contracts", async () => {
    const apis = await tools.handleListApiContracts({
      protocolFilter: "ALL",
    });

    expect(apis.protocolsSupported).toContain("REST");
    expect(apis.protocolsSupported).toContain("SOAP");
    expect(apis.protocolsSupported).toContain("GRPC");
    expect(apis.protocolsSupported).toContain("CORBA");
    expect(apis.contracts.length).toBeGreaterThan(0);
  });

  it("Step 6: should synthesize an ADR markdown document", async () => {
    const adrResult = await tools.handleGenerateAdr({
      title: "SQLite WAL Dedicated Writer Architecture",
      context: "Concurrent readers and serial writers without database locks.",
      decision: "Adopt PRAGMA journal_mode = WAL with dedicated writer thread.",
    });

    expect(adrResult.adr).toContain("# ADR-");
    expect(adrResult.adr).toContain("## Status: Accepted");
    expect(adrResult.adr).toContain("SQLite WAL Dedicated Writer Architecture");
  });

  it("Step 7: should purge cache respecting GDPR/LGPD Right to be Forgotten", async () => {
    const purgeResult = await tools.handlePurgeCache({
      confirm: true,
      vacuum: true,
    });

    expect(purgeResult.status).toBe("purged");
    expect(purgeResult.vacuumExecuted).toBe(true);
  });

  it("Step 8: should generate valid OpenCode configuration JSON via CLI", () => {
    const output = execSync(`node ${cliPath} --print-opencode-config`, {
      encoding: "utf8",
    });

    const config = JSON.parse(output);
    expect(config.mcpServers.autodoc).toBeDefined();
    expect(config.mcpServers.autodoc.env.AUTODOC_LOCALE).toBe("en-US");
    expect(config.mcpServers.autodoc.command).toBe("node");
  });
});
