import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AutoDocTools } from "../src/tools/handlers.js";
import { loadNativeBinding } from "../src/binding.js";
import { I18nManager } from "../src/i18n/index.js";
import { existsSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("AutoDoc Advanced Architecture & Multi-Contract E2E Test", () => {
  let tools: AutoDocTools;
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "autodoc-advanced-"));
    writeFileSync(join(repoRoot, "app.js"), [
      "app.get('/api/health', healthHandler);",
      "socket.on('ping', pingHandler);",
      "function healthHandler() { return { ok: true }; }",
      "function pingHandler() { return 'pong'; }",
    ].join("\n"));
    writeFileSync(join(repoRoot, "helper.py"), "def helper():\n    return True\n");
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "vitest" } }));
    writeFileSync(join(repoRoot, "Dockerfile"), "FROM node:22\nCMD [\"node\", \"app.js\"]\n");
    const binding = loadNativeBinding();
    const i18n = new I18nManager("en-US");
    tools = new AutoDocTools(binding, i18n);
  });
  afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));

  it("Step 1: Scan repository with AST Polyglot Engine and populate SQLite WAL symbols & edges", async () => {
    const scan = await tools.handleScanRepository({
      repoPath: repoRoot,
      deepScan: true,
      enablePiiScrubbing: true,
    });

    expect(scan.status).toBe("SUCCESS");
    expect(scan.scannedFiles).toBe(2);
    expect(scan.totalLoc).toBeGreaterThan(0);
    expect(scan.totalSymbols).toBeGreaterThan(0);
    expect(scan.languages.length).toBeGreaterThan(0);
    expect(existsSync(scan.cacheLocation)).toBe(true);
  });

  it("Step 2: Dynamic C4 Model generation for Level 1, 2 and 3", async () => {
    const l1 = await tools.handleGetC4Diagram({ repoPath: repoRoot, level: 1, format: "mermaid" });
    expect(l1.diagram).toContain("C4Context");
    expect(l1.diagram).toContain("Enterprise_Boundary");
    expect(l1.diagram).not.toContain("CoreApp");

    const l2 = await tools.handleGetC4Diagram({ repoPath: repoRoot, level: 2, format: "mermaid" });
    expect(l2.diagram).toContain("C4Container");
    expect(l2.diagram).toContain("Container_Boundary");

    const l3 = await tools.handleGetC4Diagram({ repoPath: repoRoot, level: 3, format: "mermaid" });
    expect(l3.diagram).toContain("C4Component");
  });

  it("Step 3: Discover REST API contracts semantically without static mocks", async () => {
    const apiRes = await tools.handleListApiContracts({ repoPath: repoRoot, protocolFilter: "ALL" });
    expect(apiRes.contracts.length).toBeGreaterThan(0);
    for (const c of apiRes.contracts) {
      expect(c.endpoint).toBeDefined();
      expect(c.method).toBeDefined();
    }
  });

  it("Step 4: Discover Realtime Socket.io and WebRTC event contracts", async () => {
    const socketRes = await tools.handleListSocketContracts({ repoPath: repoRoot, directionFilter: "ALL" });
    expect(socketRes.contracts.length).toBeGreaterThan(0);
    const directions = socketRes.contracts.map((c) => c.direction);
    expect(directions.some((d) => ["CLIENT_TO_SERVER", "SERVER_TO_CLIENT", "BIDIRECTIONAL"].includes(d))).toBe(true);
  });

  it("Step 5: Synthesize and export full Diátaxis documentation structure to disk", async () => {
    const targetDir = join(tmpdir(), "autodoc_diataxis_e2e_" + Date.now());
    const exportRes = await tools.handleExportDocumentation({ repoPath: repoRoot, outputDir: targetDir });

    expect(exportRes.status).toBe("SUCCESS");
    expect(exportRes.filesGenerated).toBeGreaterThanOrEqual(6);

    expect(existsSync(join(targetDir, "architecture", "system-overview.md"))).toBe(true);
    expect(existsSync(join(targetDir, "architecture", "quirks-and-dead-code.md"))).toBe(true);
    expect(existsSync(join(targetDir, "reference", "http-endpoints.md"))).toBe(true);
    expect(existsSync(join(targetDir, "reference", "socket-events.md"))).toBe(true);
    expect(existsSync(join(targetDir, "reference", "data-models.md"))).toBe(true);
    expect(existsSync(join(targetDir, "tutorials", "getting-started.md"))).toBe(true);

    // Cleanup
    rmSync(targetDir, { recursive: true, force: true });
  });
});
