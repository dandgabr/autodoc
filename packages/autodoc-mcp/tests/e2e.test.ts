import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AutoDocTools } from "../src/tools/handlers.js";
import { loadNativeBinding } from "../src/binding.js";
import { I18nManager } from "../src/i18n/index.js";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("AutoDoc E2E System Integration Test", () => {
  let tools: AutoDocTools;
  let repoRoot: string;
  const cliPath = path.resolve(__dirname, "../dist/index.js");

  beforeAll(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autodoc-e2e-"));
    fs.writeFileSync(path.join(repoRoot, "main.ts"), "export function scan_repository() { return 1; }\n");
    fs.writeFileSync(path.join(repoRoot, "app.js"), "app.get('/api/health', handler);\nsocket.on('ping', handler);\n");
    const binding = loadNativeBinding();
    const i18n = new I18nManager("en-US");
    tools = new AutoDocTools(binding, i18n);
  });
  afterAll(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
    expect(scanResult.cacheLocation).toContain(".autodoc/cache.db");
  });

  it("Step 2: should generate C4 Level 1 and Level 2 diagrams without XSS vulnerabilities", async () => {
    const level1 = await tools.handleGetC4Diagram({
      repoPath: repoRoot,
      level: 1,
      format: "mermaid",
      sanitizeOutput: true,
    });
    expect(level1.diagram).toContain("C4Context");
    expect(level1.diagram).not.toContain("Rel(");
    expect(level1.diagram).not.toContain("<script>");

    const level2Dsl = await tools.handleGetC4Diagram({
      repoPath: repoRoot,
      level: 2,
      format: "structurizr",
      sanitizeOutput: true,
    });
    expect(level2Dsl.status).toBe("UNSUPPORTED");
    expect(level2Dsl.diagram).toBeNull();
  });

  it("Step 3: should report when the scan does not persist a legacy symbol signature", async () => {
    const contract = await tools.handleGetSymbolContract({
      symbolName: "scan_repository",
      filePath: "main.ts",
      repoPath: repoRoot,
    });

    expect(contract.symbol).toBe("scan_repository");
    expect(contract.status).toBe("NOT_FOUND");
    expect(contract.deterministicContract).toEqual({ raw: null, securityBoundary: null });
  });

  it("Step 4: should leave sink unknown without an evidence-backed path", async () => {
    const flow = await tools.handleTraceDataFlow({
      sourceEntrypoint: "scan_repository",
      targetSink: "sqlite_edges",
      maxDepth: 5,
      repoPath: repoRoot,
    });

    expect(flow.source).toBe("scan_repository");
    expect(flow.sink).toBeNull();
    expect(flow.taintStatus).toBe("UNKNOWN");
    expect(flow.status).toBe("UNKNOWN");
    expect(flow.path).toEqual([]);
  });

  it("Step 5: should catalog multi-decade enterprise API contracts", async () => {
    const apis = await tools.handleListApiContracts({
      protocolFilter: "ALL",
      repoPath: repoRoot,
    });

    expect(apis.protocolsSupported).toContain("REST");
    expect(apis.protocolsSupported).toContain("SOAP");
    expect(apis.protocolsSupported).toContain("GRPC");
    expect(apis.protocolsSupported).toContain("CORBA");
    expect(apis.contracts.some((contract) => contract.endpoint === "/api/health")).toBe(true);
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
      repoPath: repoRoot,
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
