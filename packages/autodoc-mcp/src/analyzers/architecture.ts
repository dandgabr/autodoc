import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceAnalyzer, WorkspaceInfo } from "./workspace.js";
import { ContainerInfraAnalyzer, ContainerInfraReport } from "./containers.js";
import { SchemaAnalyzer } from "./schema/index.js";
import { isTestPath } from "./utils.js";
import { repositoryCachePath } from "../analysis/cache-state.js";
import type { SnapshotContext } from "../analysis/snapshot.js";
import { readInventoryFiles, readVerifiedSource, StaleSourceError } from "../analysis/source-reader.js";
import { buildArchitectureMap, type ArchitectureMapKind, type MapProjection } from "../analysis/map.js";

export interface ArchitectureNode {
  id: string;
  label: string;
  desc?: string;
  type?: "person" | "system" | "container" | "component" | "external" | "database";
  technology?: string;
  state?: "inventory" | "confirmed" | "hypothesis";
  evidenceIds?: string[];
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  label?: string;
  technology?: string;
  id?: string;
  state?: "confirmed" | "hypothesis";
  evidenceIds?: string[];
}

export interface ArchitectureGraph {
  level: number;
  title: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  scanId?: string;
  repositoryRoot?: string;
  coverage?: MapProjection["coverage"];
}

export class ArchitectureAnalyzer {
  private repoPath: string;
  private dbPath: string;
  private workspaceInfo: WorkspaceInfo;
  private containerReport: ContainerInfraReport;
  private envKeys: Set<string>;
  private snapshot?: SnapshotContext;

  constructor(repoPath: string = process.cwd(), snapshot?: SnapshotContext) {
    this.repoPath = repoPath;
    this.snapshot = snapshot;
    this.dbPath = repositoryCachePath(repoPath);
    this.workspaceInfo = new WorkspaceAnalyzer(repoPath, snapshot).analyze();
    this.containerReport = new ContainerInfraAnalyzer(repoPath, snapshot).analyze();
    this.envKeys = snapshot ? new Set() : this.readEnvExampleKeys();
  }

  public getArchitectureMap(kind: ArchitectureMapKind): MapProjection {
    if (!this.snapshot) throw new Error("Architecture maps require a pinned SnapshotContext.");
    return buildArchitectureMap(this.snapshot, kind);
  }

  public getArchitectureGraph(level: number = 2, maxNodes: number = 35): ArchitectureGraph {
    const repoName = this.workspaceInfo.rootName || basename(this.repoPath) || "Target System";
    const manifest = this.readManifest();

    if (this.snapshot && level >= 3) {
      const projection = buildArchitectureMap(this.snapshot, level === 3 ? "structure" : "code");
      return this.toArchitectureGraph(projection, level, repoName, maxNodes);
    }

    if (level === 1) {
      return this.buildLevel1Context(repoName, manifest);
    } else if (level === 2) {
      return this.buildLevel2Container(repoName, manifest);
    } else if (level === 3) {
      return this.buildLevel3Files(repoName, maxNodes);
    } else {
      return this.buildLevel4Code(repoName, manifest, maxNodes);
    }
  }

  private readManifest(): Record<string, any> {
    if (this.snapshot) {
      const file = readInventoryFiles(this.snapshot).find((item) => item.path === "package.json" && !item.excludedReason);
      if (!file?.contentSha256) return {};
      try { return JSON.parse(readVerifiedSource(this.snapshot, file.path).toString("utf8")); }
      catch (error) {
        if (error instanceof StaleSourceError) throw error;
        return {};
      }
    }
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

  private toArchitectureGraph(projection: MapProjection, level: number, repoName: string, maxNodes: number): ArchitectureGraph {
    const nodes: ArchitectureNode[] = projection.nodes.slice(0, maxNodes).map((node) => ({
      id: node.id,
      label: node.label,
      desc: node.kind,
      type: node.kind.startsWith("file:") ? "component" : "component",
      technology: typeof node.attributes?.category === "string" ? node.attributes.category : undefined,
      state: node.state,
      evidenceIds: node.evidenceIds,
    }));
    const included = new Set(nodes.map((node) => node.id));
    const edges: ArchitectureEdge[] = projection.relations
      .filter((relation) => relation.state === "confirmed" && relation.toId !== null && included.has(relation.fromId) && included.has(relation.toId))
      .map((relation) => ({ id: relation.id, from: relation.fromId, to: relation.toId!, label: relation.kind, state: "confirmed", evidenceIds: relation.evidenceIds }));
    const title = level === 3 ? `${repoName} — file map` : `${repoName} - Code Map`;
    return { level, title, nodes, edges, scanId: projection.scanId, repositoryRoot: projection.repositoryRoot, coverage: projection.coverage };
  }

  private buildLevel1Context(repoName: string, manifest: Record<string, any>): ArchitectureGraph {
    return {
      level: 1,
      title: `${repoName} - C4 Level 1: System Context`,
      nodes: [{ id: "repository", label: repoName, desc: manifest.description || "Repository root", type: "system" }],
      edges: [],
    };
  }

  private buildLevel2Container(repoName: string, manifest: Record<string, any>): ArchitectureGraph {
    const nodes: ArchitectureNode[] = this.workspaceInfo.packages.map((pkg) => ({
      id: `package:${pkg.name}`,
      label: pkg.name,
      desc: `Package declared by ${pkg.manifestPath}`,
      type: "container",
      technology: pkg.type,
    }));
    const packageIds = new Set(nodes.map((node) => node.id));
    const edges: ArchitectureEdge[] = this.workspaceInfo.packages.flatMap((pkg) =>
      pkg.internalDependencies
        .filter((dependency) => packageIds.has(`package:${dependency}`))
        .map((dependency) => ({ from: `package:${pkg.name}`, to: `package:${dependency}`, label: "declares workspace dependency" })),
    );
    for (const service of this.containerReport.services) {
      nodes.push({
        id: `service:${service.name}`,
        label: service.name,
        desc: `Container service declared in ${service.sourceFile}`,
        type: service.role === "database" ? "database" : "container",
        technology: service.image || service.technology,
      });
    }

    return {
      level: 2,
      title: `${repoName} - C4 Level 2: Container Architecture`,
      nodes,
      edges,
    };
  }

  private buildLevel3Files(repoName: string, maxNodes: number): ArchitectureGraph {
    const nodes: ArchitectureNode[] = [];
    if (!this.hasActiveScan()) return { level: 3, title: `${repoName} — file map`, nodes, edges: [] };
    if (existsSync(this.dbPath)) {
      try {
        const db = new DatabaseSync(this.dbPath, { readOnly: true });
        const files = db.prepare("SELECT path, language FROM files ORDER BY path LIMIT ?1").all(maxNodes) as Array<{ path: string; language: string }>;
        for (const file of files) nodes.push({ id: `file_${nodes.length}`, label: file.path, desc: "Inventoried file", type: "component", technology: file.language });
        db.close();
      } catch { /* Missing inventory remains empty. */ }
    }
    return { level: 3, title: `${repoName} — file map`, nodes, edges: [] };
  }

  private buildLevel4Code(repoName: string, _manifest: Record<string, any>, maxNodes: number): ArchitectureGraph {
    const nodes: ArchitectureNode[] = [];
    const edges: ArchitectureEdge[] = [];
    if (!this.hasActiveScan()) return { level: 4, title: `${repoName} - Code Map`, nodes, edges };

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
    // Empty evidence stays empty; callers can report that the requested level is unsupported.

    // Connect and represent Polymorphic Data Models & Discriminators
    try {
      const schemaAnalyzer = new SchemaAnalyzer(this.repoPath);
      const allModels = schemaAnalyzer.discoverModels(100, false);
      const discriminators = allModels.filter((m) => m.isDiscriminator);

      // Add Base Polymorphic models (e.g., Match)
      const baseModelsSeen = new Set<string>();
      for (const disc of discriminators) {
        const baseName = disc.baseModel;
        if (baseName && !baseModelsSeen.has(baseName)) {
          baseModelsSeen.add(baseName);
          const baseId = `model_base_${baseName.toLowerCase()}`;
          if (!nodes.some((n) => n.id === baseId)) {
            nodes.push({
              id: baseId,
              label: `${baseName} (Base Model)`,
              desc: disc.discriminatorKey
                ? `Root polymorphic model using discriminator key '${disc.discriminatorKey}'`
                : "Root polymorphic model; discriminator key not identified",
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
              desc: disc.baseModel
                ? `Discriminator variant on ${disc.baseModel} (${disc.collectionOrTable})`
                : `Discriminator model (${disc.collectionOrTable}); base model not identified`,
              type: "component",
              technology: `${disc.framework} Discriminator`,
            });
            if (disc.baseModel) {
              const baseId = `model_base_${disc.baseModel.toLowerCase()}`;
              edges.push({
                from: discId,
                to: baseId,
                label: disc.discriminatorKey ? `discriminates (${disc.discriminatorKey})` : "discriminates",
                technology: "ODM Inheritance",
              });
            }
          }
        }
      }
    } catch {
      // Best-effort schema enrichment
    }

    return {
      level: 4,
      title: `${repoName} - Code Map`,
      nodes,
      edges,
    };
  }

  private hasActiveScan(): boolean {
    if (!existsSync(this.dbPath)) return false;
    try {
      const db = new DatabaseSync(this.dbPath, { readOnly: true });
      try {
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_state'").get();
        if (!table) return false;
        const row = db.prepare('SELECT active_scan_id FROM scan_state WHERE singleton=1').get() as { active_scan_id: string | null } | undefined;
        return Boolean(row?.active_scan_id);
      } finally { db.close(); }
    } catch { return false; }
  }
}
