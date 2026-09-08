import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { WorkspaceAnalyzer } from "../src/analyzers/workspace.js";
import { ContainerInfraAnalyzer } from "../src/analyzers/containers.js";
import { RestAnalyzer } from "../src/analyzers/rest/index.js";
import { RealtimeAnalyzer } from "../src/analyzers/realtime/index.js";
import { SchemaAnalyzer } from "../src/analyzers/schema/index.js";
import { ArchitectureAnalyzer } from "../src/analyzers/architecture.js";
import { DiataxisGenerator } from "../src/diataxis/generator.js";

describe("Agnostic Discovery Engines (Workspace, Containers, REST, Realtime, Schema, Diataxis)", () => {
  const butecoPath = "/home/daniel/Code/butecogames";
  const autodocPath = "/home/daniel/Code/autodoc";

  it("should analyze workspace structure and package manager accurately", () => {
    const analyzer = new WorkspaceAnalyzer(butecoPath);
    const info = analyzer.analyze();

    expect(info.isMonorepo).toBe(true);
    expect(info.packageManager).toBe("pnpm");
    expect(info.packages.length).toBeGreaterThanOrEqual(3);
    expect(info.commands.install).toBe("pnpm install");
    expect(info.commands.build).toBe("pnpm build");
    expect(info.commands.test).toBe("pnpm test");

    // Verify Makefile detection
    expect(info.makefile?.hasMakefile).toBe(true);
    expect(info.makefile?.targets).toContain("dev");
    expect(info.makefile?.targets).toContain("down");
    expect(info.makefile?.recommendedCommand).toBe("make dev");
  });

  it("should analyze container infrastructure agnostically", () => {
    const analyzer = new ContainerInfraAnalyzer(butecoPath);
    const report = analyzer.analyze();

    expect(report.detectedPatterns).toContain("docker-compose");
    expect(report.services.length).toBeGreaterThanOrEqual(2);

    const mongo = report.services.find((s) => s.technology.includes("MongoDB"));
    const valkey = report.services.find((s) => s.technology.includes("Valkey"));

    expect(mongo).toBeDefined();
    expect(valkey).toBeDefined();
    expect(mongo?.role).toBe("database");
    expect(valkey?.role).toBe("cache");
  });

  it("should discover modular REST endpoints with mounted prefixes", () => {
    const analyzer = new RestAnalyzer(butecoPath);
    const endpoints = analyzer.discoverEndpoints("ALL", 200);

    expect(endpoints.length).toBeGreaterThan(50);

    // Verify mounted prefix resolution
    const lotteryEndpoints = endpoints.filter((e) => e.endpoint.startsWith("/api/animal-lottery"));
    expect(lotteryEndpoints.length).toBeGreaterThan(0);

    const userEndpoints = endpoints.filter((e) => e.endpoint.startsWith("/api/users"));
    expect(userEndpoints.length).toBeGreaterThan(0);

    // Verify authentication detection
    const authProtected = endpoints.filter((e) => e.auth?.includes("Bearer") || e.auth?.includes("Session"));
    expect(authProtected.length).toBeGreaterThan(0);

    // Verify canonical router mount disambiguation (no phantom /api/users/users/:id/role)
    const adminRoleEndpoint = endpoints.find((e) => e.endpoint.includes("/role"));
    expect(adminRoleEndpoint).toBeDefined();
    expect(adminRoleEndpoint?.endpoint).toBe("/api/admin/users/:userId/role");

    const phantomDuplicate = endpoints.find((e) => e.endpoint.includes("/api/users/users"));
    expect(phantomDuplicate).toBeUndefined();
  });

  it("should discover realtime contracts across room runtime and game modules", () => {
    const analyzer = new RealtimeAnalyzer(butecoPath);
    const events = analyzer.discoverSocketContracts("ALL", 250);

    expect(events.length).toBeGreaterThan(80);

    // Verify game events
    const rouletteEvents = events.filter((e) => e.eventName.startsWith("roulette:"));
    expect(rouletteEvents.length).toBeGreaterThan(0);

    const bombetaEvents = events.filter((e) => e.eventName.startsWith("bombeta:"));
    expect(bombetaEvents.length).toBeGreaterThan(0);

    // Verify room runtime events
    const roomEvents = events.filter((e) => e.eventName.startsWith("room:"));
    expect(roomEvents.length).toBeGreaterThan(0);

    // Verify direction tagging
    const c2s = events.filter((e) => e.direction === "CLIENT_TO_SERVER");
    const s2c = events.filter((e) => e.direction === "SERVER_TO_CLIENT");
    expect(c2s.length).toBeGreaterThan(0);
    expect(s2c.length).toBeGreaterThan(0);
  });

  it("should discover polymorphic data models and discriminators", () => {
    const analyzer = new SchemaAnalyzer(butecoPath);
    const models = analyzer.discoverModels(100);

    expect(models.length).toBeGreaterThan(25);

    // Verify discriminators
    const discriminators = models.filter((m) => m.isDiscriminator || m.collectionOrTable.includes("matches"));
    expect(discriminators.length).toBeGreaterThan(0);

    // Verify soft-delete and timestamps
    const withTimestamps = models.filter((m) => m.hasTimestamps);
    expect(withTimestamps.length).toBeGreaterThan(0);

    // Verify subdocument filtering: rounddatas and viewers must NOT be root collections
    const rootCollections = models.map((m) => m.collectionOrTable.toLowerCase());
    expect(rootCollections).not.toContain("rounddatas");
    expect(rootCollections).not.toContain("viewers");

    // Verify subdocuments are classified when includeSubdocuments is true
    const allModels = analyzer.discoverModels(150, true);
    const viewerSubdoc = allModels.find((m) => m.modelName.toLowerCase().includes("viewer"));
    expect(viewerSubdoc).toBeDefined();
    expect(viewerSubdoc?.isSubdocument).toBe(true);
  });

  it("should generate semantic C4 diagrams with real infrastructure nodes", () => {
    const analyzer = new ArchitectureAnalyzer(butecoPath);

    const level1 = analyzer.getArchitectureGraph(1);
    expect(level1.nodes.some((n) => n.id === "DiscordAuthExt")).toBe(true);
    expect(level1.nodes.some((n) => n.id === "CloudflareSfuExt")).toBe(true);
    expect(level1.nodes.some((n) => n.id === "MongoDbExt")).toBe(true);
    expect(level1.nodes.some((n) => n.id === "ValkeyExt")).toBe(true);

    const level2 = analyzer.getArchitectureGraph(2);
    expect(level2.nodes.some((n) => n.id === "ClientApp")).toBe(true);
    expect(level2.nodes.some((n) => n.id === "ApiGateway")).toBe(true);
    expect(level2.nodes.some((n) => n.id === "SharedKernel")).toBe(true);
    expect(level2.nodes.some((n) => n.id === "PrimaryDb")).toBe(true);
    expect(level2.nodes.some((n) => n.id === "CacheCluster")).toBe(true);
  });

  it("should synthesize complete Diataxis living documentation structure", () => {
    const generator = new DiataxisGenerator(butecoPath);
    const docs = generator.synthesizeFullDocumentation();

    expect(docs.length).toBeGreaterThanOrEqual(20);

    const gettingStarted = docs.find((d) => d.relativePath === "tutorials/getting-started.md");
    expect(gettingStarted).toBeDefined();
    expect(gettingStarted?.content).toContain("pnpm install");
    expect(gettingStarted?.content).toContain("docker compose up -d");
    expect(gettingStarted?.content).toContain("make dev");

    const howTo = docs.find((d) => d.relativePath === "how-to/add-new-module.md");
    expect(howTo).toBeDefined();
    expect(howTo?.content).toContain("boundary.test.ts");

    const moduleCatalog = docs.find((d) => d.relativePath === "reference/modules-catalog.md");
    expect(moduleCatalog).toBeDefined();

    const rouletteRef = docs.find((d) => d.relativePath === "reference/modules/roulette.md");
    expect(rouletteRef).toBeDefined();
    expect(rouletteRef?.content).toContain("roulette:place_bet");
  });

  it("should exclude test suite noise by default and include when requested", () => {
    // 1. RealtimeAnalyzer: channels.test.ts defines dummy channels room:abc and room:abc:spectators
    const productionRealtime = new RealtimeAnalyzer(butecoPath, { includeTests: false });
    const prodEvents = productionRealtime.discoverSocketContracts("ALL", 500);

    const hasTestDummyRoom = prodEvents.some(
      (e) => e.eventName === "room:abc" || e.eventName === "room:abc:spectators"
    );
    expect(hasTestDummyRoom).toBe(false);

    const testInclusiveRealtime = new RealtimeAnalyzer(butecoPath, { includeTests: true });
    const allEvents = testInclusiveRealtime.discoverSocketContracts("ALL", 500);
    const hasTestDummyRoomInInclusive = allEvents.some(
      (e) => e.eventName === "room:abc" || e.eventName === "room:abc:spectators"
    );
    expect(hasTestDummyRoomInInclusive).toBe(true);

    // 2. RestAnalyzer: should exclude test files by default
    const prodRest = new RestAnalyzer(butecoPath, { includeTests: false });
    const prodEndpoints = prodRest.discoverEndpoints("ALL", 500);
    const hasTestEndpoint = prodEndpoints.some(
      (e) => e.sourceFile?.includes(".test.") || e.sourceFile?.includes(".spec.")
    );
    expect(hasTestEndpoint).toBe(false);
  });
});
