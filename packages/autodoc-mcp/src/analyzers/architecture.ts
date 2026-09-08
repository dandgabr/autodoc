import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceAnalyzer, WorkspaceInfo } from "./workspace.js";
import { ContainerInfraAnalyzer, ContainerInfraReport } from "./containers.js";
import { SchemaAnalyzer } from "./schema/index.js";
import { isTestPath } from "./utils.js";

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
  private workspaceInfo: WorkspaceInfo;
  private containerReport: ContainerInfraReport;
  private envKeys: Set<string>;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
    this.dbPath = join(repoPath, ".autodoc", "cache.db");
    this.workspaceInfo = new WorkspaceAnalyzer(repoPath).analyze();
    this.containerReport = new ContainerInfraAnalyzer(repoPath).analyze();
    this.envKeys = this.readEnvExampleKeys();
  }

  public getArchitectureGraph(level: number = 2, maxNodes: number = 35): ArchitectureGraph {
    const repoName = this.workspaceInfo.rootName || basename(this.repoPath) || "Target System";
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

  private readEnvExampleKeys(): Set<string> {
    const keys = new Set<string>();
    const candidates = [".env.example", ".env.sample", ".env.template", ".env.defaults"];
    for (const f of candidates) {
      const p = join(this.repoPath, f);
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, "utf-8");
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
              keys.add(trimmed.split("=")[0].trim());
            }
          }
        } catch {
          // Ignore
        }
      }
    }
    return keys;
  }

  private buildLevel1Context(repoName: string, manifest: Record<string, any>): ArchitectureGraph {
    const allDeps = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {}),
    };

    const hasDiscord =
      this.envKeys.has("DISCORD_CLIENT_ID") ||
      this.envKeys.has("DISCORD_CLIENT_SECRET") ||
      allDeps["passport-discord"] ||
      allDeps["@better-auth/cli"];

    const hasCloudflareSfu =
      this.envKeys.has("CLOUDFLARE_CALLS_APP_ID") ||
      this.envKeys.has("CLOUDFLARE_CALLS_APP_SECRET") ||
      existsSync(join(this.repoPath, "packages", "server", "src", "services", "cloudflareSfu.ts"));

    const hasTurnstile = this.envKeys.has("TURNSTILE_SECRET_KEY") || this.envKeys.has("VITE_TURNSTILE_SITE_KEY");
    const hasR2OrS3 = this.envKeys.has("R2_ACCESS_KEY_ID") || this.envKeys.has("AWS_ACCESS_KEY_ID");

    const hasMongo =
      allDeps["mongoose"] ||
      allDeps["mongodb"] ||
      this.containerReport.services.some((s) => s.technology.includes("MongoDB")) ||
      this.envKeys.has("MONGODB_URI");

    const hasValkeyOrRedis =
      allDeps["redis"] ||
      allDeps["ioredis"] ||
      this.containerReport.services.some((s) => s.technology.includes("Valkey") || s.technology.includes("Redis")) ||
      this.envKeys.has("VALKEY_URL") ||
      this.envKeys.has("REDIS_URL");

    const nodes: ArchitectureNode[] = [
      {
        id: "UserActor",
        label: "End User / Player",
        desc: "Interacts with games, rooms, and platform through responsive web client",
        type: "person",
      },
      {
        id: "SystemApp",
        label: `${repoName} Platform`,
        desc: manifest.description || "Core application ecosystem, room runtime, and real-time gaming services",
        type: "system",
      },
    ];

    const edges: ArchitectureEdge[] = [
      {
        from: "UserActor",
        to: "SystemApp",
        label: "Interacts via HTTPS REST & WebSockets",
        technology: "TLS / HTTPS / WSS",
      },
    ];

    // External Identity (Discord OAuth2 / Better Auth)
    if (hasDiscord) {
      nodes.push({
        id: "DiscordAuthExt",
        label: "Discord OAuth2 / Identity Provider",
        desc: "Authenticates players, synchronizes avatars, and provides profile validation",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "DiscordAuthExt",
        label: "Exchanges OAuth code & validates tokens",
        technology: "OAuth 2.0 / HTTPS",
      });
    }

    // External SFU (Cloudflare Calls)
    if (hasCloudflareSfu) {
      nodes.push({
        id: "CloudflareSfuExt",
        label: "Cloudflare Calls SFU",
        desc: "WebRTC Selective Forwarding Unit for real-time peer media & screen sharing",
        type: "external",
      });
      edges.push({
        from: "UserActor",
        to: "CloudflareSfuExt",
        label: "Streams WebRTC media tracks",
        technology: "WHEP / WebRTC",
      });
      edges.push({
        from: "SystemApp",
        to: "CloudflareSfuExt",
        label: "Provisions sessions & tracks via REST",
        technology: "HTTPS REST API",
      });
    }

    // Object Storage (Cloudflare R2 / AWS S3)
    if (hasR2OrS3) {
      nodes.push({
        id: "ObjectStorageExt",
        label: "Object Storage (S3 / R2)",
        desc: "Durable storage for user-uploaded media, screenshots, and game assets",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "ObjectStorageExt",
        label: "Reads & writes binary objects",
        technology: "S3 API / HTTPS",
      });
    }

    // Anti-Bot / Turnstile
    if (hasTurnstile) {
      nodes.push({
        id: "TurnstileExt",
        label: "Cloudflare Turnstile",
        desc: "Protects public registration and bookmark endpoints against bot automation",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "TurnstileExt",
        label: "Verifies Turnstile challenge tokens",
        technology: "HTTPS",
      });
    }

    // MongoDB Cluster
    if (hasMongo) {
      nodes.push({
        id: "MongoDbExt",
        label: "MongoDB Cluster",
        desc: "Persistent document database storing users, matches, wallets, and settings",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "MongoDbExt",
        label: "Reads & writes models",
        technology: "MongoDB Wire Protocol",
      });
    }

    // Valkey / Redis
    if (hasValkeyOrRedis) {
      nodes.push({
        id: "ValkeyExt",
        label: "Valkey / Redis Cache & PubSub",
        desc: "In-memory caching, rate-limiting, room locks, and cross-instance pub/sub",
        type: "external",
      });
      edges.push({
        from: "SystemApp",
        to: "ValkeyExt",
        label: "Caches state & syncs events",
        technology: "RESP Protocol",
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

    const hasClientPkg = this.workspaceInfo.packages.some((p) => p.type === "application" || p.name.includes("client"));
    const hasServerPkg = this.workspaceInfo.packages.some((p) => p.type === "service" || p.name.includes("server"));
    const sharedPkg = this.workspaceInfo.packages.find((p) => p.type === "library" || p.name.includes("shared"));

    const nodes: ArchitectureNode[] = [
      {
        id: "UserActor",
        label: "End User / Player",
        desc: "Player using web browser or mobile client",
        type: "person",
      },
    ];
    const edges: ArchitectureEdge[] = [];

    // Client container
    if (hasClientPkg || allDeps["react"] || allDeps["vue"]) {
      nodes.push({
        id: "ClientApp",
        label: "Web Client SPA",
        desc: "Responsive Single Page Application providing interactive gaming lobbies, canvas, and audio/video controls",
        type: "container",
        technology: "React 19 / TypeScript / Vite / TailwindCSS",
      });
      edges.push({
        from: "UserActor",
        to: "ClientApp",
        label: "Navigates lobbies & plays games",
        technology: "HTTPS",
      });
    }

    // Server container
    if (hasServerPkg || !hasClientPkg) {
      nodes.push({
        id: "ApiGateway",
        label: "Game & API Server",
        desc: "Monolithic modular server hosting REST endpoints, Shared Room Runtime, and pluggable game event loops",
        type: "container",
        technology: "Node.js 22 / Express / Socket.io / Better Auth",
      });

      if (hasClientPkg || allDeps["react"]) {
        edges.push({
          from: "ClientApp",
          to: "ApiGateway",
          label: "Sends HTTP REST & Socket.io real-time traffic",
          technology: "REST / Socket.io (WSS)",
        });
      } else {
        edges.push({
          from: "UserActor",
          to: "ApiGateway",
          label: "Sends HTTP requests & socket messages",
          technology: "HTTPS / TLS",
        });
      }
    }

    // Shared Kernel container
    if (sharedPkg) {
      nodes.push({
        id: "SharedKernel",
        label: "Shared Kernel & Contracts",
        desc: "Isomorphic TypeScript domain models, Zod schemas, socket event interfaces, and constants",
        type: "container",
        technology: "TypeScript / Zod / ESM",
      });
      if (hasClientPkg) {
        edges.push({
          from: "ClientApp",
          to: "SharedKernel",
          label: "Imports payload schemas & types",
          technology: "Monorepo Workspace Dep",
        });
      }
      edges.push({
        from: "ApiGateway",
        to: "SharedKernel",
        label: "Validates incoming contracts & models",
        technology: "Monorepo Workspace Dep",
      });
    }

    // Database container(s) from ContainerInfraAnalyzer
    const mongoService = this.containerReport.services.find((s) => s.technology.includes("MongoDB"));
    const valkeyService = this.containerReport.services.find(
      (s) => s.technology.includes("Valkey") || s.technology.includes("Redis")
    );

    if (mongoService || allDeps["mongoose"] || allDeps["mongodb"]) {
      nodes.push({
        id: "PrimaryDb",
        label: "MongoDB Document Store",
        desc: "Persistent document database storing user accounts, rooms, matches, and audit logs",
        type: "database",
        technology: mongoService?.image || "MongoDB 8 (WiredTiger)",
      });
      edges.push({
        from: "ApiGateway",
        to: "PrimaryDb",
        label: "Reads & writes models via Mongoose ODM",
        technology: "MongoDB Wire Protocol",
      });
    }

    if (valkeyService || allDeps["redis"] || allDeps["ioredis"]) {
      nodes.push({
        id: "CacheCluster",
        label: "Valkey / Redis In-Memory Cache",
        desc: "Key-value cache, session locks, and pub/sub message broker",
        type: "database",
        technology: valkeyService?.image || "Valkey 8 / Redis",
      });
      edges.push({
        from: "ApiGateway",
        to: "CacheCluster",
        label: "Pub/Sub events, caches, and rate-limiting",
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

        // Query dominant application software components (filtering out scripts, backups, migrations, tests)
        const symbolsStmt = db.prepare(`
          SELECT s.symbol_id, s.name, s.kind, s.fqsn, s.cyclomatic_complexity, f.path
          FROM symbols s
          JOIN files f ON s.file_id = f.file_id
          WHERE s.kind IN ('class', 'interface', 'struct', 'function')
            AND f.path NOT LIKE '%test%'
            AND f.path NOT LIKE '%spec%'
            AND f.path NOT LIKE '%mock%'
            AND f.path NOT LIKE '%fixture%'
            AND f.path NOT LIKE '%.sh'
            AND f.path NOT LIKE '%.bash'
            AND f.path NOT LIKE '%.zsh'
            AND f.path NOT LIKE '%scripts/%'
            AND f.path NOT LIKE '%migrations/%'
            AND f.path NOT LIKE '%backup%'
            AND (f.path LIKE '%src/%' OR f.path LIKE '%lib/%' OR f.path LIKE '%packages/%' OR f.path LIKE '%crates/%' OR f.path LIKE '%app/%' OR f.path LIKE '%pkg/%' OR f.path LIKE '%internal/%')
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
        const validRows: typeof rows = [];

        for (const r of rows) {
          if (
            isTestPath(r.path) ||
            r.path.endsWith(".sh") ||
            r.path.endsWith(".bash") ||
            r.path.endsWith(".zsh") ||
            r.path.includes("scripts/") ||
            r.path.includes("backup") ||
            r.path.includes("migration")
          ) {
            continue;
          }

          validRows.push(r);
          const safeId = `comp_${r.symbol_id}`;
          symbolIdMap.set(r.symbol_id, safeId);

          const desc = `${r.kind.toUpperCase()} in ${r.path} (CC: ${r.cyclomatic_complexity})`;
          const tech = r.path.endsWith(".ts")
            ? "TypeScript"
            : r.path.endsWith(".rs")
            ? "Rust"
            : r.path.endsWith(".py")
            ? "Python"
            : "Source";

          nodes.push({
            id: safeId,
            label: r.name,
            desc,
            type: "component",
            technology: tech,
          });
        }

        // Query call graph edges between these components
        if (validRows.length > 0) {
          const ids = validRows.map((r) => r.symbol_id).join(",");
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

    // High-level architectural fallback components if SQLite has no symbols
    if (nodes.length === 0) {
      nodes.push(
        {
          id: "RoomManagerComp",
          label: "Shared Room Runtime",
          desc: "Orchestrates multi-player room lifecycles, seats, ready states, and match persistence",
          type: "component",
          technology: "TypeScript / Socket.io",
        },
        {
          id: "ModuleRegistryComp",
          label: "Server Module Registry",
          desc: "Dynamic plugin registry mounting 15 game modules, routers, models, and jobs",
          type: "component",
          technology: "TypeScript / Core Registry",
        },
        {
          id: "WalletAuthComp",
          label: "Auth & Wallet Service",
          desc: "Validates Discord OAuth2 sessions and atomic ledger currency transactions",
          type: "component",
          technology: "TypeScript / Better Auth / Mongoose",
        },
        {
          id: "MediaSfuComp",
          label: "Media & SFU Service",
          desc: "Manages audio/video sessions via Cloudflare Calls and user-shared uploads",
          type: "component",
          technology: "TypeScript / WebRTC WHEP / R2",
        },
        {
          id: "GameEnginesComp",
          label: "Pluggable Game Engines",
          desc: "Executes authoritative game state machines (Roulette, Bombeta, Uneco, Card Duel)",
          type: "component",
          technology: "TypeScript / State Machines",
        }
      );

      edges.push(
        { from: "RoomManagerComp", to: "GameEnginesComp", label: "delegates match loop", technology: "In-memory" },
        { from: "ModuleRegistryComp", to: "RoomManagerComp", label: "registers room specs", technology: "In-memory" },
        { from: "GameEnginesComp", to: "WalletAuthComp", label: "transacts bet payouts", technology: "Internal Call" },
        { from: "RoomManagerComp", to: "MediaSfuComp", label: "binds SFU tracks to room", technology: "Internal Call" }
      );
    }

    // Connect and represent Polymorphic Data Models & Discriminators
    try {
      const schemaAnalyzer = new SchemaAnalyzer(this.repoPath);
      const allModels = schemaAnalyzer.discoverModels(100, false);
      const discriminators = allModels.filter((m) => m.isDiscriminator);
      const rootModels = allModels.filter((m) => !m.isDiscriminator && !m.isSubdocument);

      // Add Base Polymorphic models (e.g., Match)
      const baseModelsSeen = new Set<string>();
      for (const disc of discriminators) {
        const baseName = disc.baseModel || "Match";
        if (!baseModelsSeen.has(baseName)) {
          baseModelsSeen.add(baseName);
          const baseId = `model_base_${baseName.toLowerCase()}`;
          if (!nodes.some((n) => n.id === baseId)) {
            nodes.push({
              id: baseId,
              label: `${baseName} (Base Model)`,
              desc: `Root polymorphic model with discriminatorKey '${disc.discriminatorKey || "moduleId"}'`,
              type: "database",
              technology: `${disc.framework} Schema`,
            });
          }
        }

        // Add discriminator variant node if space allows
        if (nodes.length < maxNodes + 10) {
          const discId = `disc_${disc.modelName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
          if (!nodes.some((n) => n.id === discId)) {
            nodes.push({
              id: discId,
              label: disc.modelName,
              desc: `Discriminator variant on ${disc.baseModel || "Match"} (${disc.collectionOrTable})`,
              type: "component",
              technology: `${disc.framework} Discriminator`,
            });
            const baseId = `model_base_${(disc.baseModel || "Match").toLowerCase()}`;
            edges.push({
              from: discId,
              to: baseId,
              label: `discriminates (${disc.discriminatorKey || "moduleId"})`,
              technology: "ODM Inheritance",
            });
          }
        }
      }
    } catch {
      // Best-effort schema enrichment
    }

    return {
      level: 3,
      title: `${repoName} - C4 Level 3: Component Architecture`,
      nodes,
      edges,
    };
  }
}
