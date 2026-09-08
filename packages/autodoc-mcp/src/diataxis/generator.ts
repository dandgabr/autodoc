import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { ArchitectureAnalyzer } from "../analyzers/architecture.js";
import { RestAnalyzer, DiscoveredEndpoint } from "../analyzers/rest/index.js";
import { RealtimeAnalyzer, DiscoveredSocketEvent } from "../analyzers/realtime/index.js";
import { SchemaAnalyzer, DataModelContract, DataField } from "../analyzers/schema/index.js";
import { HonestyAnalyzer, DeadCodeItem } from "../analyzers/honesty/index.js";
import { DiagramRenderer } from "../diagrams/renderer.js";

export interface GeneratedDocFile {
  relativePath: string;
  title: string;
  content: string;
  quadrant: "tutorials" | "how-to" | "reference" | "explanation";
}

export class DiataxisGenerator {
  private repoPath: string;
  private archAnalyzer: ArchitectureAnalyzer;
  private restAnalyzer: RestAnalyzer;
  private realtimeAnalyzer: RealtimeAnalyzer;
  private schemaAnalyzer: SchemaAnalyzer;
  private honestyAnalyzer: HonestyAnalyzer;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
    this.archAnalyzer = new ArchitectureAnalyzer(repoPath);
    this.restAnalyzer = new RestAnalyzer(repoPath);
    this.realtimeAnalyzer = new RealtimeAnalyzer(repoPath);
    this.schemaAnalyzer = new SchemaAnalyzer(repoPath);
    this.honestyAnalyzer = new HonestyAnalyzer(repoPath);
  }

  public synthesizeFullDocumentation(): GeneratedDocFile[] {
    const docs: GeneratedDocFile[] = [];
    const repoName = basename(this.repoPath);

    // 1. QUADRANT: Explanation / Architecture
    const c4Context = this.archAnalyzer.getArchitectureGraph(1);
    const c4Container = this.archAnalyzer.getArchitectureGraph(2);
    const mermaidContext = DiagramRenderer.renderC4Mermaid(c4Context);
    const mermaidContainer = DiagramRenderer.renderC4Mermaid(c4Container);

    docs.push({
      relativePath: "architecture/system-overview.md",
      title: "System Architecture & C4 Topology",
      quadrant: "explanation",
      content: [
        `# Architecture Overview: ${repoName}`,
        "",
        "## 1. System Context (C4 Level 1)",
        "```mermaid",
        mermaidContext,
        "```",
        "",
        "## 2. Container Architecture (C4 Level 2)",
        "```mermaid",
        mermaidContainer,
        "```",
        "",
        "## 3. Technology Stack Summary",
        `- **Core Application**: ${repoName}`,
        `- **Data Persistence**: MongoDB / Relational Storage Engine`,
        `- **Communication Protocols**: HTTP REST & Real-time WebSockets / WebRTC`,
      ].join("\n"),
    });

    // Honesty Policy & Quirks Report
    const honesty = this.honestyAnalyzer.generateHonestyReport();
    docs.push({
      relativePath: "architecture/quirks-and-dead-code.md",
      title: "Honesty Policy: Quirks & Dead Code",
      quadrant: "explanation",
      content: [
        `# Honesty Policy: Quirks & Dead Code Report`,
        "",
        `Generated at: \`${honesty.timestamp}\``,
        "",
        `Total Divergences Detected: **${honesty.totalDeadCodeCount}**`,
        "",
        "## 1. Dead Declared Socket Events",
        honesty.deadDeclaredEvents.length === 0
          ? "_No dead socket events detected in declared interfaces._"
          : honesty.deadDeclaredEvents
              .map((d: DeadCodeItem) => `- **\`${d.name}\`** (\`${d.sourceFile}\`): ${d.reason}`)
              .join("\n"),
        "",
        "## 2. Undeclared Socket Events",
        honesty.undeclaredEvents.length === 0
          ? "_All imperative socket emissions are covered by typed contracts._"
          : honesty.undeclaredEvents
              .map((u: DeadCodeItem) => `- **\`${u.name}\`** (\`${u.sourceFile}\`): ${u.reason}`)
              .join("\n"),
        "",
        "## 3. Orphan Function Symbols",
        honesty.orphanSymbols.length === 0
          ? "_Zero unreachable symbols detected._"
          : honesty.orphanSymbols
              .map((s: DeadCodeItem) => `- **\`${s.name}\`** (\`${s.sourceFile}\`): ${s.reason}`)
              .join("\n"),
      ].join("\n"),
    });

    // 2. QUADRANT: Reference (Information-oriented)
    // HTTP Endpoints
    const endpoints = this.restAnalyzer.discoverEndpoints("ALL", 100);
    const endpointRows = endpoints.map(
      (e: DiscoveredEndpoint) =>
        `| \`${e.method}\` | \`${e.endpoint}\` | ${e.protocol} | ${e.auth || "None"} | \`${e.sourceFile || "routes"}\` |`
    );

    docs.push({
      relativePath: "reference/http-endpoints.md",
      title: "HTTP REST Endpoints Catalog",
      quadrant: "reference",
      content: [
        `# HTTP REST Endpoints Reference`,
        "",
        `Total Endpoints Cataloged: **${endpoints.length}**`,
        "",
        "| Method | Route Endpoint | Protocol | Authentication | Source File |",
        "| :--- | :--- | :--- | :--- | :--- |",
        ...endpointRows,
      ].join("\n"),
    });

    // Socket Events
    const socketEvents = this.realtimeAnalyzer.discoverSocketContracts("ALL", 100);
    const socketRows = socketEvents.map(
      (s: DiscoveredSocketEvent) =>
        `| \`${s.eventName}\` | ${s.direction} | ${s.protocol} | \`${s.payloadType || "any"}\` | ${
          s.isTypedContract ? "Yes" : "No"
        } | \`${s.sourceFile}\` |`
    );

    docs.push({
      relativePath: "reference/socket-events.md",
      title: "Realtime WebSocket & WebRTC Contracts",
      quadrant: "reference",
      content: [
        `# Realtime WebSocket & WebRTC Contracts`,
        "",
        `Total Realtime Events Cataloged: **${socketEvents.length}**`,
        "",
        "| Event Name | Direction | Protocol | Payload Type | Typed Contract | Source File |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
        ...socketRows,
      ].join("\n"),
    });

    // Data Models
    const models = this.schemaAnalyzer.discoverModels(50);
    const modelSections = models.map((m: DataModelContract) => {
      const fieldRows = m.fields.map(
        (f: DataField) =>
          `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "Yes" : "No"} | ${f.indexed ? "Indexed" : "-"} |`
      );
      return [
        `### Model: \`${m.modelName}\` (\`${m.collectionOrTable}\`)`,
        `- **Framework**: ${m.framework}`,
        `- **Soft Delete**: ${m.hasSoftDelete ? "Enabled" : "Disabled"}`,
        `- **Timestamps**: ${m.hasTimestamps ? "Enabled" : "Disabled"}`,
        `- **Source**: \`${m.sourceFile}\``,
        "",
        "| Field Name | Type | Required | Indexing |",
        "| :--- | :--- | :--- | :--- |",
        ...fieldRows,
        "",
      ].join("\n");
    });

    docs.push({
      relativePath: "reference/data-models.md",
      title: "Data Models & Persistence Schemas",
      quadrant: "reference",
      content: [
        `# Data Models & Persistence Schemas`,
        "",
        `Total Data Models Discovered: **${models.length}**`,
        "",
        ...modelSections,
      ].join("\n"),
    });

    // 3. QUADRANT: Tutorials (Learning-oriented)
    docs.push({
      relativePath: "tutorials/getting-started.md",
      title: "Getting Started Developer Guide",
      quadrant: "tutorials",
      content: [
        `# Getting Started with ${repoName}`,
        "",
        "## Prerequisites",
        "- Node.js >= 22.0.0",
        "- npm or pnpm package manager",
        "",
        "## Setup & Installation",
        "```bash",
        "# Clone and install dependencies",
        "npm install",
        "",
        "# Build native binaries and typescript modules",
        "npm run build",
        "",
        "# Run automated test suite",
        "npm test",
        "```",
      ].join("\n"),
    });

    // 4. QUADRANT: How-To Guides (Task-oriented)
    docs.push({
      relativePath: "how-to/add-new-module.md",
      title: "How-To: Add a New Domain Module",
      quadrant: "how-to",
      content: [
        `# How-To: Add a New Domain Module to ${repoName}`,
        "",
        "1. Define domain entities in shared contracts.",
        "2. Implement business logic and state machine handlers in service controllers.",
        "3. Register REST routers and Socket.io event listeners.",
        "4. Run `autodoc_scan_repository` to re-index the AST graph into SQLite.",
      ].join("\n"),
    });

    return docs;
  }

  public exportToDirectory(targetDir: string): { totalFiles: number; writtenFiles: string[] } {
    const docs = this.synthesizeFullDocumentation();
    const writtenFiles: string[] = [];

    for (const doc of docs) {
      const fullPath = join(targetDir, doc.relativePath);
      const parentDir = join(fullPath, "..");
      mkdirSync(parentDir, { recursive: true });
      writeFileSync(fullPath, doc.content, "utf-8");
      writtenFiles.push(doc.relativePath);
    }

    return {
      totalFiles: writtenFiles.length,
      writtenFiles,
    };
  }
}
