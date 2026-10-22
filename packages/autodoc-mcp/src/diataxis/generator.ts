import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { ArchitectureAnalyzer } from "../analyzers/architecture.js";
import { RestAnalyzer, DiscoveredEndpoint } from "../analyzers/rest/index.js";
import { RealtimeAnalyzer, DiscoveredSocketEvent } from "../analyzers/realtime/index.js";
import { SchemaAnalyzer, DataModelContract, DataField } from "../analyzers/schema/index.js";
import { HonestyAnalyzer, DeadCodeItem } from "../analyzers/honesty/index.js";
import { WorkspaceAnalyzer, WorkspaceInfo } from "../analyzers/workspace.js";
import { ContainerInfraAnalyzer, ContainerInfraReport } from "../analyzers/containers.js";
import { DiagramRenderer } from "../diagrams/renderer.js";
import { DocumentationExporter } from "./exporter.js";
import type { SnapshotContext } from "../analysis/snapshot.js";
import { type ArchitectureMapKind, type MapProjection } from "../analysis/map.js";

export interface GeneratedDocFile {
  relativePath: string;
  title: string;
  content: string;
  quadrant: "tutorials" | "how-to" | "reference" | "explanation";
  scanId?: string;
  repositoryRoot?: string;
}

export interface DiscoveredModuleInfo {
  id: string;
  dirPath: string;
  kind?: string;
  uses: string[];
  routes: DiscoveredEndpoint[];
  socketEvents: DiscoveredSocketEvent[];
  models: DataModelContract[];
}

export interface DiataxisGeneratorOptions {
  includeTests?: boolean;
  snapshot?: SnapshotContext;
}

export class DiataxisGenerator {
  private repoPath: string;
  private includeTests: boolean;
  private archAnalyzer: ArchitectureAnalyzer;
  private restAnalyzer: RestAnalyzer;
  private realtimeAnalyzer: RealtimeAnalyzer;
  private schemaAnalyzer: SchemaAnalyzer;
  private honestyAnalyzer: HonestyAnalyzer;
  private workspaceInfo: WorkspaceInfo;
  private containerReport: ContainerInfraReport;
  private snapshot?: SnapshotContext;

  constructor(repoPath: string = process.cwd(), options: DiataxisGeneratorOptions = {}) {
    this.repoPath = repoPath;
    this.includeTests = options.includeTests ?? false;
    this.snapshot = options.snapshot;
    this.archAnalyzer = new ArchitectureAnalyzer(repoPath, this.snapshot);
    this.restAnalyzer = new RestAnalyzer(repoPath, { includeTests: this.includeTests, snapshot: this.snapshot });
    this.realtimeAnalyzer = new RealtimeAnalyzer(repoPath, { includeTests: this.includeTests, snapshot: this.snapshot });
    this.schemaAnalyzer = new SchemaAnalyzer(repoPath, { includeTests: this.includeTests, snapshot: this.snapshot });
    this.honestyAnalyzer = new HonestyAnalyzer(repoPath, this.snapshot);
    this.workspaceInfo = new WorkspaceAnalyzer(repoPath, this.snapshot).analyze();
    this.containerReport = new ContainerInfraAnalyzer(repoPath, this.snapshot).analyze();
  }

  private projectionDiagram(projection: MapProjection, level: number, title: string): string {
    const nodes = projection.nodes.map((node) => ({
      id: node.id, label: node.label, desc: node.kind, type: "component" as const,
      technology: typeof node.attributes?.category === "string" ? node.attributes.category : undefined,
      state: node.state, evidenceIds: node.evidenceIds,
    }));
    const edges = projection.relations.filter((relation) => relation.state === "confirmed" && relation.toId !== null)
      .map((relation) => ({ id: relation.id, from: relation.fromId, to: relation.toId!, label: relation.kind, state: "confirmed" as const, evidenceIds: relation.evidenceIds }));
    return DiagramRenderer.renderC4Mermaid({ level, title, nodes, edges });
  }

  private renderProjectionIndex(kinds: ArchitectureMapKind[]): string {
    if (!this.snapshot) return "";
    const sections = kinds.map((kind) => {
      const projection = this.archAnalyzer.getArchitectureMap(kind);
      const inventoryOnly = projection.nodes.length > 0 && projection.nodes.every((node) => node.state === "inventory");
      const state = projection.nodes.length === 0 ? "UNSUPPORTED" : projection.coverage.state !== "complete" || (kind === "infrastructure" && inventoryOnly) ? "PARTIAL" : "AVAILABLE";
      return [
        `## ${kind}`,
        "",
        `State: **${state}**. Coverage: **${projection.coverage.state}**. Scan: \`${projection.scanId}\`.`,
        projection.nodes.length === 0 ? "No supported facts are persisted for this map." : "",
        "",
        "### Nodes",
        "",
        ...(projection.nodes.length ? projection.nodes.map((node) => `- \`${node.id}\` — ${node.label} (${node.state}; evidence: ${node.evidenceIds.join(", ") || "none"})`) : ["_None._"]),
        "",
        "### Relations",
        "",
        ...(projection.relations.length ? projection.relations.map((relation) => `- \`${relation.id}\`: \`${relation.fromId}\` → \`${relation.toId ?? "unresolved"}\` (${relation.kind}; ${relation.state}; evidence: ${relation.evidenceIds.join(", ") || "none"})`) : ["_None._"]),
      ].filter((line) => line !== undefined).join("\n");
    });
    return ["# Repository Maps", "", `Repository: \`${this.snapshot.repositoryRoot}\``, `Scan: \`${this.snapshot.scanId}\``, "", ...sections].join("\n");
  }

  public synthesizeFullDocumentation(): GeneratedDocFile[] {
    const docs: GeneratedDocFile[] = [];
    const repoName = this.workspaceInfo.rootName || basename(this.repoPath);

    // 1. QUADRANT: Explanation / Architecture
    const c4ContextProjection = this.snapshot ? this.archAnalyzer.getArchitectureMap("context") : undefined;
    const c4ContainerProjection = this.snapshot ? this.archAnalyzer.getArchitectureMap("infrastructure") : undefined;
    const c4Container = this.snapshot ? undefined : this.archAnalyzer.getArchitectureGraph(2);
    const mermaidContext = c4ContextProjection
      ? this.projectionDiagram(c4ContextProjection, 1, `${repoName} - C4 Level 1: Repository Context`)
      : DiagramRenderer.renderC4Mermaid(this.archAnalyzer.getArchitectureGraph(1));
    const mermaidContainer = c4ContainerProjection
      ? this.projectionDiagram(c4ContainerProjection, 2, `${repoName} - C4 Level 2: Infrastructure Inventory`)
      : DiagramRenderer.renderC4Mermaid(c4Container!);

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
        `- **Project Type**: ${this.workspaceInfo.isMonorepo ? "Monorepo Workspace" : "Single Package Project"}`,
        `- **Package Manager**: \`${this.workspaceInfo.packageManager}\``,
        `- **Primary Container Orchestration**: \`${this.containerReport.primaryContainerOrchestration}\``,
        `- **Discovered Containers / Services**: ${
          this.containerReport.services.length === 0
            ? "None"
            : this.containerReport.services.map((s) => `\`${s.name}\` (${s.technology})`).join(", ")
        }`,
      ].join("\n"),
    });

    if (this.snapshot) {
      docs.push({
        relativePath: "architecture/repository-maps.md",
        title: "Repository Maps",
        quadrant: "explanation",
        content: this.renderProjectionIndex(["context", "structure", "imports", "entrypoints", "infrastructure", "code"]),
      });
    }

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
        `Analysis coverage: **${honesty.coverage}**. Candidate findings: **${honesty.candidateCount}**. No candidate count proves code is dead.`,
        "",
        "## 1. Dead Declared Socket Events",
        honesty.deadDeclaredEvents.length === 0
          ? "_No dead socket events detected in declared interfaces._"
          : honesty.deadDeclaredEvents
              .map(
                (d: DeadCodeItem) =>
                  `- **\`${d.name}\`** (\`${d.sourceFile}\`)${
                    d.confidence ? ` [Confidence: **${d.confidence.toUpperCase()}**]` : ""
                  }: ${d.reason}`
              )
              .join("\n"),
        "",
        "## 2. Undeclared Socket Events",
        honesty.undeclaredEvents.length === 0
          ? "_All imperative socket emissions are covered by typed contracts._"
          : honesty.undeclaredEvents
              .map((u: DeadCodeItem) => `- **\`${u.name}\`** (\`${u.sourceFile}\`): ${u.reason}`)
              .join("\n"),
        "",
        "## 3. Functions Without a Confirmed Caller (Candidates)",
        honesty.orphanSymbols.length === 0
          ? "_No candidates were found in the available call graph; coverage may be incomplete._"
          : honesty.orphanSymbols
              .map((s: DeadCodeItem) => `- **\`${s.name}\`** (\`${s.sourceFile}\`): ${s.reason}`)
              .join("\n"),
      ].join("\n"),
    });

    // 2. QUADRANT: Reference (Information-oriented)
    // HTTP Endpoints
    const endpoints = this.restAnalyzer.discoverEndpoints("ALL", Number.MAX_SAFE_INTEGER);
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
    const socketEvents = this.realtimeAnalyzer.discoverSocketContracts("ALL", Number.MAX_SAFE_INTEGER);
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
    const rootModels = this.schemaAnalyzer.discoverModels(Number.MAX_SAFE_INTEGER, false);
    const allModels = this.schemaAnalyzer.discoverModels(Number.MAX_SAFE_INTEGER, true);
    const subdocuments = allModels.filter((m) => m.isSubdocument);

    const renderModelCard = (m: DataModelContract) => {
      const fieldRows = m.fields.map(
        (f: DataField) =>
          `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "Yes" : "No"} | ${f.indexed ? "Indexed" : "-"} |`
      );
      const indexSummary =
        m.compoundIndexes && m.compoundIndexes.length > 0
          ? `- **Compound Indexes**: ${m.compoundIndexes
              .map((ci) => `\`{ ${Object.keys(ci.fields).join(", ")} }\`${ci.unique ? " (unique)" : ""}`)
              .join("; ")}`
          : "";

      return [
        `### ${m.isSubdocument ? "Embedded Structure" : "Model"}: \`${m.modelName}\` (\`${m.collectionOrTable}\`)`,
        `- **Framework**: ${m.framework}`,
        m.parentModel ? `- **Containing Parent Model**: \`${m.parentModel}\`` : "",
        `- **Soft Delete**: ${m.hasSoftDelete ? "Enabled" : "Disabled"}`,
        `- **Timestamps**: ${m.hasTimestamps ? "Enabled" : "Disabled"}`,
        m.isDiscriminator
          ? `- **Polymorphic Discriminator**: Base \`${m.baseModel || "Parent"}\`${
              m.discriminatorKey ? ` (Discriminator Key: \`${m.discriminatorKey}\`)` : ""
            }`
          : "",
        indexSummary,
        `- **Source**: \`${m.sourceFile}\``,
        "",
        fieldRows.length > 0 ? "| Field Name | Type | Required | Indexing |\n| :--- | :--- | :--- | :--- |\n" + fieldRows.join("\n") : "_No top-level scalar fields or polymorphic child schema._",
        "",
      ].filter(Boolean).join("\n");
    };

    const rootModelSections = rootModels.map(renderModelCard);
    const subdocSections = subdocuments.map(renderModelCard);

    docs.push({
      relativePath: "reference/data-models.md",
      title: "Data Models & Persistence Schemas",
      quadrant: "reference",
      content: [
        `# Data Models & Persistence Schemas`,
        "",
        `Total Root Models & Collections: **${rootModels.length}** | Embedded Subdocuments: **${subdocuments.length}**`,
        "",
        "## 1. Root Models & Collections",
        "",
        ...rootModelSections,
        "",
        ...(subdocuments.length > 0
          ? [
              "## 2. Embedded Subdocuments & Value Objects",
              "",
              ...subdocSections,
            ]
          : []),
      ].join("\n"),
    });

    // Tutorials only describe workflows supported by detected manifests and scripts.
    const pm = this.workspaceInfo.packageManager;
    const cmds = this.workspaceInfo.commands;
    if (pm !== "unknown") {
      const workflow = [
        `# Getting Started with ${repoName}`,
        "",
        `Detected package manager: \`${pm}\`.`,
      ];
      const detectedCommands = [
        ["Build", cmds.build], ["Test", cmds.test], ["Development", cmds.dev],
      ].filter((entry): entry is [string, string] => entry[1] !== null);
      if (detectedCommands.length) {
        workflow.push("", "## Detected project commands", "", ...detectedCommands.map(([label, command]) => `- **${label}:** \`${command}\``));
      }
      docs.push({ relativePath: "tutorials/getting-started.md", title: "Getting Started", quadrant: "tutorials", content: workflow.join("\n") });
    }

    return docs.map((doc) => this.snapshot ? {
      ...doc,
      scanId: this.snapshot.scanId,
      repositoryRoot: this.snapshot.repositoryRoot,
      content: `> Repository snapshot: \`${this.snapshot.scanId}\` at \`${this.snapshot.repositoryRoot}\`.\n\n${doc.content}`,
    } : doc);
  }

  public exportToDirectory(targetDir: string): { totalFiles: number; writtenFiles: string[] } {
    return new DocumentationExporter().export(targetDir, this.synthesizeFullDocumentation());
  }

  private readNvmVersion(): string | null {
    const nvmPath = join(this.repoPath, ".nvmrc");
    if (existsSync(nvmPath)) {
      try {
        return readFileSync(nvmPath, "utf-8").trim();
      } catch {
        return null;
      }
    }
    return null;
  }

  private buildContainerInstructions(): string {
    if (
      existsSync(join(this.repoPath, "docker-compose.yml")) ||
      existsSync(join(this.repoPath, "compose.yml"))
    ) {
      return "# Start backend services (databases, caches, message brokers)\ndocker compose up -d";
    }
    if (existsSync(join(this.repoPath, "podman-compose.yml"))) {
      return "# Start containers with Podman\npodman-compose up -d";
    }
    if (this.containerReport.detectedPatterns.includes("podman-quadlet")) {
      return "# Start Podman Quadlet systemd user services\nsystemctl --user start autodoc.target";
    }
    if (this.containerReport.detectedPatterns.includes("kubernetes")) {
      return "# Apply Kubernetes cluster manifests\nkubectl apply -f k8s/";
    }
    return "# Start local database and caching daemons";
  }
}
