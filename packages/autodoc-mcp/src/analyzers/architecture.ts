import { existsSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ArchitectureNode {
  id: string;
  label: string;
  desc?: string;
  type?: "person" | "system" | "container" | "component" | "external" | "database";
  technology?: string;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  label?: string;
  technology?: string;
}

export interface ArchitectureGraph {
  level: number;
  title: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
}

export class ArchitectureAnalyzer {
  private repoPath: string;
  private dbPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
    this.dbPath = join(repoPath, ".autodoc", "cache.db");
  }

  public getArchitectureGraph(level: number = 2, maxNodes: number = 35): ArchitectureGraph {
    const repoName = basename(this.repoPath) || "Target System";
    const manifest = this.readManifest();

    if (level === 1) {
      return this.buildLevel1Context(repoName, manifest);
    } else if (level === 2) {
      return this.buildLevel2Container(repoName, manifest);
    } else {
      return this.buildLevel3Component(repoName, manifest, maxNodes);
    }
  }

  private readManifest(): Record<string, any> {
    const pkgPath = join(this.repoPath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        return JSON.parse(readFileSync(pkgPath, "utf-8"));
      } catch {
        return {};
      }
    }
    return {};
  }

  private buildLevel1Context(repoName: string, manifest: Record<string, any>): ArchitectureGraph {
    const allDeps = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {}),
    };

    const nodes: ArchitectureNode[] = [
      {
        id: "UserActor",
        label: "End User / Player",
        desc: "Uses web client interface to interact with the application",
        type: "person",
      },
      {
        id: "SystemApp",
        label: `${repoName} Platform`,
        desc: manifest.description || "Core application ecosystem and service mesh",
        type: "system",
      },
    ];

    const edges: ArchitectureEdge[] = [
      {
        from: "UserActor",
        to: "SystemApp",
        label: "Interacts via HTTPS & WebSockets",
        technology: "Browser / TLS",
      },
    ];

    // External Databases
    if (allDeps["mongoose"] || allDeps["mongodb"]) {
      nodes.push({
        id: "MongoDbExt",
        label: "MongoDB Cluster",
        desc: "Persistent document database for application state & accounts",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "MongoDbExt",
        label: "Reads & writes documents",
        technology: "MongoDB Wire Protocol",
      });
    }

    if (allDeps["redis"] || allDeps["ioredis"]) {
      nodes.push({
        id: "RedisExt",
        label: "Redis Cache & Pub/Sub",
        desc: "In-memory caching, rate-limiting, and real-time pub/sub broker",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "RedisExt",
        label: "Caches state & syncs real-time events",
        technology: "RESP Protocol",
      });
    }

    if (allDeps["pg"] || allDeps["typeorm"] || allDeps["prisma"]) {
      nodes.push({
        id: "RelationalDbExt",
        label: "Relational Database",
        desc: "ACID transactions, relational records, and ledger persistence",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "RelationalDbExt",
        label: "Executes SQL transactions",
        technology: "PostgreSQL / MySQL",
      });
    }

    // External OAuth / APIs
    if (allDeps["passport"] || allDeps["jsonwebtoken"] || allDeps["axios"]) {
      nodes.push({
        id: "ExternalAuthExt",
        label: "External Identity & OAuth Provider",
        desc: "User identity verification and third-party account linking",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "ExternalAuthExt",
        label: "Authenticates tokens & profiles",
        technology: "OAuth 2.0 / OIDC",
      });
    }

    return {
      level: 1,
      title: `${repoName} - C4 Level 1: System Context`,
      nodes,
      edges,
    };
  }

  private buildLevel2Container(repoName: string, manifest: Record<string, any>): ArchitectureGraph {
    const allDeps = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {}),
    };

    const hasClient = existsSync(join(this.repoPath, "packages", "client")) ||
      existsSync(join(this.repoPath, "client")) ||
      existsSync(join(this.repoPath, "src", "client")) ||
      allDeps["react"] || allDeps["vue"] || allDeps["vite"];

    const hasServer = existsSync(join(this.repoPath, "packages", "server")) ||
      existsSync(join(this.repoPath, "server")) ||
      existsSync(join(this.repoPath, "src", "server")) ||
      allDeps["express"] || allDeps["fastify"] || allDeps["@nestjs/core"];

    const hasShared = existsSync(join(this.repoPath, "packages", "shared")) ||
      existsSync(join(this.repoPath, "shared")) ||
      existsSync(join(this.repoPath, "src", "shared"));

    const nodes: ArchitectureNode[] = [
      {
        id: "UserActor",
        label: "User",
        desc: "End user utilizing the application",
        type: "person",
      },
    ];
    const edges: ArchitectureEdge[] = [];

    if (hasClient) {
      nodes.push({
        id: "ClientApp",
        label: "Web Client SPA",
        desc: "Responsive Single Page Application delivering user interfaces",
        type: "container",
        technology: allDeps["react"] ? "React / TypeScript / Vite" : "Vue / TypeScript / Vite",
      });
      edges.push({
        from: "UserActor",
        to: "ClientApp",
        label: "Views and interacts with UI",
        technology: "HTTPS",
      });
    }

    if (hasServer || !hasClient) {
      nodes.push({
        id: "ApiGateway",
        label: "API & Realtime Gateway",
        desc: "Handles HTTP REST endpoints, WebSocket event loops, and authorization",
        type: "container",
        technology: allDeps["socket.io"] ? "Node.js / Express / Socket.io" : "Node.js / Express / REST",
      });

      if (hasClient) {
        edges.push({
          from: "ClientApp",
          to: "ApiGateway",
          label: "Sends API requests & real-time events",
          technology: allDeps["socket.io"] ? "REST / Socket.io" : "REST / JSON",
        });
      } else {
        edges.push({
          from: "UserActor",
          to: "ApiGateway",
          label: "Sends HTTP / WebSocket traffic",
          technology: "TLS / HTTPS",
        });
      }
    }

    if (hasShared) {
      nodes.push({
        id: "SharedKernel",
        label: "Shared Kernel & Domain Models",
        desc: "Common type definitions, validation schemas, and protocol contracts",
        type: "container",
        technology: "TypeScript / Zod",
      });
      if (hasClient) {
        edges.push({
          from: "ClientApp",
          to: "SharedKernel",
          label: "Imports types & schemas",
          technology: "ESM",
        });
      }
      edges.push({
        from: "ApiGateway",
        to: "SharedKernel",
        label: "Validates payloads & contracts",
        technology: "ESM",
      });
    }

    // Databases & persistence containers
    if (allDeps["mongoose"] || allDeps["mongodb"]) {
      nodes.push({
        id: "PrimaryDb",
        label: "Primary Database",
        desc: "Stores user profiles, transactional history, and application state",
        type: "database",
        technology: "MongoDB WAL",
      });
      edges.push({
        from: "ApiGateway",
        to: "PrimaryDb",
        label: "Reads & writes models",
        technology: "Mongoose ODM",
      });
    }

    if (allDeps["redis"] || allDeps["ioredis"]) {
      nodes.push({
        id: "CacheCluster",
        label: "Cache & Session Storage",
        desc: "In-memory caching, rate-limiting, and distributed locks",
        type: "database",
        technology: "Redis",
      });
      edges.push({
        from: "ApiGateway",
        to: "CacheCluster",
        label: "Maintains session state & counters",
        technology: "RESP Protocol",
      });
    }

    return {
      level: 2,
      title: `${repoName} - C4 Level 2: Container Architecture`,
      nodes,
      edges,
    };
  }

  private buildLevel3Component(repoName: string, manifest: Record<string, any>, maxNodes: number): ArchitectureGraph {
    const nodes: ArchitectureNode[] = [];
    const edges: ArchitectureEdge[] = [];

    // Query symbols and edges from SQLite cache
    if (existsSync(this.dbPath)) {
      try {
        const db = new DatabaseSync(this.dbPath, { readOnly: true });
        
        // Query dominant components (classes, interfaces, controllers, services, routers)
        const symbolsStmt = db.prepare(`
          SELECT s.symbol_id, s.name, s.kind, s.fqsn, s.cyclomatic_complexity, f.path
          FROM symbols s
          JOIN files f ON s.file_id = f.file_id
          WHERE s.kind IN ('class', 'interface', 'struct', 'function')
          ORDER BY s.cyclomatic_complexity DESC, s.line_end - s.line_start DESC
          LIMIT ?
        `);
        const rows = symbolsStmt.all(maxNodes) as Array<{
          symbol_id: number;
          name: string;
          kind: string;
          fqsn: string;
          cyclomatic_complexity: number;
          path: string;
        }>;

        const symbolIdMap = new Map<number, string>();

        for (const r of rows) {
          const safeId = `comp_${r.symbol_id}`;
          symbolIdMap.set(r.symbol_id, safeId);

          const desc = `${r.kind.toUpperCase()} defined in ${r.path} (CC: ${r.cyclomatic_complexity})`;
          const tech = r.path.endsWith(".ts") ? "TypeScript" : r.path.endsWith(".rs") ? "Rust" : r.path.endsWith(".py") ? "Python" : "Source";

          nodes.push({
            id: safeId,
            label: r.name,
            desc,
            type: "component",
            technology: tech,
          });
        }

        // Query relationships between these components
        if (rows.length > 0) {
          const ids = rows.map((r) => r.symbol_id).join(",");
          const edgesStmt = db.prepare(`
            SELECT caller_id, callee_id, edge_kind, weight
            FROM edges
            WHERE caller_id IN (${ids}) AND callee_id IN (${ids})
            LIMIT 50
          `);
          const edgeRows = edgesStmt.all() as Array<{
            caller_id: number;
            callee_id: number;
            edge_kind: string;
            weight: number;
          }>;

          for (const e of edgeRows) {
            const from = symbolIdMap.get(e.caller_id);
            const to = symbolIdMap.get(e.callee_id);
            if (from && to && from !== to) {
              edges.push({
                from,
                to,
                label: `${e.edge_kind} (w: ${e.weight.toFixed(1)})`,
                technology: "Internal Call",
              });
            }
          }
        }

        db.close();
      } catch (err: any) {
        process.stderr.write(`[WARN] Failed to read component graph from SQLite: ${err?.message}\n`);
      }
    }

    // Fallback if no symbols or empty database
    if (nodes.length === 0) {
      nodes.push(
        { id: "ControllerComponent", label: "Request Controllers", desc: "Processes inbound REST & Socket events", type: "component", technology: "TypeScript" },
        { id: "ServiceComponent", label: "Domain Services", desc: "Executes business logic and game rules", type: "component", technology: "TypeScript" },
        { id: "PersistenceComponent", label: "Data Access Layer", desc: "Queries MongoDB/PostgreSQL models", type: "component", technology: "Mongoose / Prisma" },
      );
      edges.push(
        { from: "ControllerComponent", to: "ServiceComponent", label: "dispatches logic", technology: "In-memory" },
        { from: "ServiceComponent", to: "PersistenceComponent", label: "reads & persists", technology: "ORM Call" },
      );
    }

    return {
      level: 3,
      title: `${repoName} - C4 Level 3: Component Architecture`,
      nodes,
      edges,
    };
  }
}
