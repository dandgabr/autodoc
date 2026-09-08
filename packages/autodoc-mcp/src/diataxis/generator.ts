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

export interface GeneratedDocFile {
  relativePath: string;
  title: string;
  content: string;
  quadrant: "tutorials" | "how-to" | "reference" | "explanation";
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

  constructor(repoPath: string = process.cwd(), options: DiataxisGeneratorOptions = {}) {
    this.repoPath = repoPath;
    this.includeTests = options.includeTests ?? false;
    this.archAnalyzer = new ArchitectureAnalyzer(repoPath);
    this.restAnalyzer = new RestAnalyzer(repoPath, { includeTests: this.includeTests });
    this.realtimeAnalyzer = new RealtimeAnalyzer(repoPath, { includeTests: this.includeTests });
    this.schemaAnalyzer = new SchemaAnalyzer(repoPath, { includeTests: this.includeTests });
    this.honestyAnalyzer = new HonestyAnalyzer(repoPath);
    this.workspaceInfo = new WorkspaceAnalyzer(repoPath).analyze();
    this.containerReport = new ContainerInfraAnalyzer(repoPath).analyze();
  }

  public synthesizeFullDocumentation(): GeneratedDocFile[] {
    const docs: GeneratedDocFile[] = [];
    const repoName = this.workspaceInfo.rootName || basename(this.repoPath);

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
    const endpoints = this.restAnalyzer.discoverEndpoints("ALL", 200);
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
    const socketEvents = this.realtimeAnalyzer.discoverSocketContracts("ALL", 250);
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
    const rootModels = this.schemaAnalyzer.discoverModels(150, false);
    const allModels = this.schemaAnalyzer.discoverModels(200, true);
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

    // Business Modules Reference Catalog
    const discoveredModules = this.discoverBusinessModules(endpoints, socketEvents, rootModels);
    if (discoveredModules.length > 0) {
      const moduleSummaryRows = discoveredModules.map(
        (m) =>
          `| \`${m.id}\` | ${m.kind || "module"} | ${m.routes.length} | ${m.socketEvents.length} | ${m.models.length} | \`${m.dirPath}\` |`
      );

      docs.push({
        relativePath: "reference/modules-catalog.md",
        title: "Business & Game Modules Catalog",
        quadrant: "reference",
        content: [
          `# Business & Game Modules Catalog`,
          "",
          `Total Registered Modules: **${discoveredModules.length}**`,
          "",
          "| Module ID | Kind | REST Routes | Socket Events | Models | Path |",
          "| :--- | :--- | :--- | :--- | :--- | :--- |",
          ...moduleSummaryRows,
        ].join("\n"),
      });

      // Also synthesize individual module reference pages
      for (const mod of discoveredModules) {
        const modRouteRows = mod.routes.map((r) => `- \`${r.method} ${r.endpoint}\` (${r.auth})`);
        const modSocketRows = mod.socketEvents.map((s) => `- \`${s.eventName}\` (${s.direction})`);
        const modModelRows = mod.models.map((m) => `- \`${m.modelName}\` (collection: \`${m.collectionOrTable}\`)`);

        docs.push({
          relativePath: `reference/modules/${mod.id}.md`,
          title: `Module: ${mod.id}`,
          quadrant: "reference",
          content: [
            `# Module Reference: ${mod.id}`,
            "",
            `- **Kind**: \`${mod.kind || "game"}\``,
            `- **Directory**: \`${mod.dirPath}\``,
            `- **Capabilities Declared**: ${mod.uses.length > 0 ? mod.uses.map((u) => `\`${u}\``).join(", ") : "Standard"}`,
            "",
            "## 1. REST Endpoints",
            modRouteRows.length > 0 ? modRouteRows.join("\n") : "_No dedicated REST endpoints._",
            "",
            "## 2. Realtime Socket Events",
            modSocketRows.length > 0 ? modSocketRows.join("\n") : "_No dedicated realtime socket events._",
            "",
            "## 3. Data Models & Discriminators",
            modModelRows.length > 0 ? modModelRows.join("\n") : "_Uses shared match discriminator or transient state._",
          ].join("\n"),
        });
      }
    }

    // 3. QUADRANT: Tutorials (Learning-oriented)
    const pm = this.workspaceInfo.packageManager;
    const cmds = this.workspaceInfo.commands;
    const nvmVersion = this.readNvmVersion();

    const containerInstruction = this.buildContainerInstructions();

    docs.push({
      relativePath: "tutorials/getting-started.md",
      title: "Getting Started Developer Guide",
      quadrant: "tutorials",
      content: [
        `# Getting Started with ${repoName}`,
        "",
        "## 1. Prerequisites",
        nvmVersion ? `- Node.js ${nvmVersion}` : "- Node.js >= 22.0.0",
        `- Package Manager: \`${pm}\``,
        `- Container Engine: \`${this.containerReport.primaryContainerOrchestration}\` (Docker or Podman)`,
        "",
        "## 2. Environment Configuration",
        "```bash",
        "# Copy example environment template",
        "cp .env.example .env",
        "```",
        "_Configure database credentials (`MONGODB_URI`), cache (`VALKEY_URL`), and authentication secrets (`DISCORD_CLIENT_ID`, `BETTER_AUTH_SECRET`)._",
        "",
        "## 3. Start Infrastructure & Development Workflow",
        ...(this.workspaceInfo.makefile?.devTarget
          ? [
              "```bash",
              "# Recommended shortcut via Makefile (starts backing containers & launches dev servers):",
              `make ${this.workspaceInfo.makefile.devTarget}`,
              "```",
              "",
              "Alternatively, start backing infrastructure services independently:",
              "```bash",
              containerInstruction,
              "```",
            ]
          : [
              "```bash",
              containerInstruction,
              "```",
            ]),
        "",
        "## 4. Install Dependencies & Build",
        "```bash",
        `# Install dependencies via ${pm}`,
        cmds.install,
        "",
        "# Build monorepo packages",
        cmds.build,
        "```",
        "",
        "## 5. Running the Application & Tests",
        "```bash",
        this.workspaceInfo.makefile?.devTarget
          ? `# Run dev server (via package manager or make):\n${cmds.dev}\n# or: make ${this.workspaceInfo.makefile.devTarget}`
          : `# Run development servers\n${cmds.dev}`,
        "",
        "# Run test suite",
        cmds.test,
        ...(this.workspaceInfo.makefile?.targets.includes("down")
          ? ["", "# Stop backing services via Makefile", "make down"]
          : []),
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
        "Follow these architectural steps to create, register, and test a new pluggable domain or game module:",
        "",
        "### Step 1: Define Shared Contracts & Schemas",
        "1. Create a module directory in `packages/shared/src/modules/<module-id>/`.",
        "2. Define TypeScript types for your game state, client actions, and payload schemas (e.g. using Zod).",
        "3. Export your schemas and types from the shared package index.",
        "",
        "### Step 2: Implement Match Discriminator & Persistence (Optional)",
        "1. If your module saves game history or matches, define a discriminator schema `matchSchema.ts`.",
        "2. Export `schema` to contribute custom fields (`config`, `result`, `players[].ext`) to the shared `matches` collection.",
        "",
        "### Step 3: Implement Engine State Machine & Socket Handlers",
        "1. Implement authoritative game rules in `engine.ts`.",
        "2. Register socket event listeners and room handlers in `socket.ts`.",
        "",
        "### Step 4: Register Module via `registerServerModule`",
        "In `packages/server/src/modules/<module-id>/index.ts`:",
        "```typescript",
        "import { registerServerModule } from '../../core/registry.js';",
        "",
        "registerServerModule({",
        "  id: '<module-id>',",
        "  kind: 'game',",
        "  uses: ['wallet', 'settings', 'socketRooms'],",
        "  routers: [{ path: '/api/<module-id>', router: myRouter }],",
        "  socketEvents: ['<module-id>:action', '<module-id>:state'],",
        "  matches: { schema: myMatchSchema },",
        "  socket: (io, socket) => registerHandlers(io, socket),",
        "});",
        "```",
        "",
        "### Step 5: Enforce Boundary Testing",
        "Every module must implement boundary tests to guarantee clean room lifecycles and transactions:",
        "- Create `<module-id>.boundary.test.ts`.",
        "- Verify room joining, seat reservation, readiness countdown, and disconnect grace period.",
        "- Verify bet deduction and atomic payout settlement through `WalletService`.",
        "",
        "### Step 6: Re-scan Codebase with AutoDoc",
        "```bash",
        "# Refresh AST call-graphs, REST routes, and living documentation",
        "autodoc_scan_repository",
        "```",
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

  private discoverBusinessModules(
    endpoints: DiscoveredEndpoint[],
    socketEvents: DiscoveredSocketEvent[],
    models: DataModelContract[]
  ): DiscoveredModuleInfo[] {
    const modules: DiscoveredModuleInfo[] = [];
    const moduleDirs = [
      join(this.repoPath, "packages", "server", "src", "modules"),
      join(this.repoPath, "server", "src", "modules"),
      join(this.repoPath, "modules"),
      join(this.repoPath, "apps"),
    ];

    for (const baseDir of moduleDirs) {
      if (!existsSync(baseDir)) continue;
      try {
        const entries = readdirSync(baseDir);
        for (const entry of entries) {
          const modDir = join(baseDir, entry);
          if (statSync(modDir).isDirectory()) {
            const modId = entry;
            const indexPath = join(modDir, "index.ts");
            const indexContent = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : "";

            // Parse uses
            const usesMatch = /uses\s*:\s*\[([^\]]+)\]/.exec(indexContent);
            const uses = usesMatch
              ? usesMatch[1].split(",").map((s) => s.trim().replace(/['"`]/g, ""))
              : [];

            // Filter associated endpoints, events, models
            const modEndpoints = endpoints.filter((e) => e.sourceFile?.includes(`modules/${modId}`));
            const modEvents = socketEvents.filter(
              (s) => s.eventName.startsWith(`${modId}:`) || s.sourceFile.includes(`modules/${modId}`)
            );
            const modModels = models.filter((m) => m.sourceFile.includes(`modules/${modId}`));

            modules.push({
              id: modId,
              dirPath: `packages/server/src/modules/${modId}`,
              kind: indexContent.includes('kind: "utility"') ? "utility" : "game",
              uses,
              routes: modEndpoints,
              socketEvents: modEvents,
              models: modModels,
            });
          }
        }
      } catch {
        // Fallback
      }
    }

    return modules;
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
      return "# Start backend databases (MongoDB, Valkey/Redis)\ndocker compose up -d";
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
