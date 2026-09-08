import { RealtimeAnalyzer } from "../realtime/index.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface DeadCodeItem {
  name: string;
  type: "DEAD_DECLARED_EVENT" | "UNDECLARED_EVENT" | "ORPHAN_SYMBOL" | "ORPHAN_ROUTE";
  sourceFile: string;
  reason: string;
  confidence?: "high" | "medium" | "low";
}

export interface HonestyReport {
  timestamp: string;
  repositoryPath: string;
  totalDeadCodeCount: number;
  deadDeclaredEvents: DeadCodeItem[];
  undeclaredEvents: DeadCodeItem[];
  orphanSymbols: DeadCodeItem[];
  quirksSummary: string[];
}

export class HonestyAnalyzer {
  private repoPath: string;
  private realtimeAnalyzer: RealtimeAnalyzer;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
    this.realtimeAnalyzer = new RealtimeAnalyzer(repoPath);
  }

  public generateHonestyReport(): HonestyReport {
    const deadDeclaredEvents: DeadCodeItem[] = [];
    const undeclaredEvents: DeadCodeItem[] = [];
    const orphanSymbols: DeadCodeItem[] = [];
    const quirks: string[] = [];

    // 1. Analyze Socket Contracts vs. Actual Emits & Listens
    const allSocketEvents = this.realtimeAnalyzer.discoverSocketContracts("ALL", 200);
    const typedEvents = allSocketEvents.filter((e) => e.isTypedContract);
    const imperativeEvents = allSocketEvents.filter((e) => !e.isTypedContract);

    const imperativeNames = new Set(imperativeEvents.map((e) => e.eventName));
    const typedNames = new Set(typedEvents.map((e) => e.eventName));

    // Events declared in interfaces but never called imperatively
    for (const typed of typedEvents) {
      if (!imperativeNames.has(typed.eventName) && typed.eventName !== "connection") {
        // Evaluate heuristic confidence:
        // - low: dynamic prefix (e.g. room:*, event:*, sfu:*, rtc:*, screenshare:*) or generic keywords
        // - medium: feature/submodule prefix (e.g. module:* events) where handlers might be registered via dynamic dispatch
        // - high: specific static single-word or fully isolated event name
        let confidence: "high" | "medium" | "low" = "high";
        if (
          typed.eventName.startsWith("room:") ||
          typed.eventName.startsWith("rtc:") ||
          typed.eventName.startsWith("sfu:") ||
          typed.eventName.startsWith("webrtc:") ||
          typed.eventName.startsWith("screenshare:") ||
          typed.eventName.startsWith("presence:") ||
          typed.eventName.startsWith("notification:")
        ) {
          confidence = "low";
        } else if (typed.eventName.includes(":")) {
          confidence = "medium";
        }

        deadDeclaredEvents.push({
          name: typed.eventName,
          type: "DEAD_DECLARED_EVENT",
          sourceFile: typed.sourceFile,
          confidence,
          reason: `Declared in TypeScript socket interface (${typed.direction}) but no active emit or handler found in codebase. [Confidence: ${confidence.toUpperCase()}]`,
        });
      }
    }

    // Events called imperatively with raw string literals but missing in contract interfaces
    for (const imp of imperativeEvents) {
      if (!typedNames.has(imp.eventName)) {
        undeclaredEvents.push({
          name: imp.eventName,
          type: "UNDECLARED_EVENT",
          sourceFile: imp.sourceFile,
          reason: `Emitted or listened with string literal '${imp.eventName}', but not declared in typed Socket.io interfaces.`,
        });
      }
    }

    // 2. Query SQLite edges for orphan symbols (in-degree = 0)
    const dbPath = join(this.repoPath, ".autodoc", "cache.db");
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const stmt = db.prepare(`
          SELECT s.name, s.kind, s.fqsn, f.path
          FROM symbols s
          JOIN files f ON s.file_id = f.file_id
          WHERE s.kind IN ('function', 'method')
            AND s.symbol_id NOT IN (SELECT DISTINCT callee_id FROM edges)
            AND s.name NOT IN ('main', 'start', 'init', 'index', 'run', 'handler')
          LIMIT 15
        `);
        const rows = stmt.all() as Array<{ name: string; kind: string; fqsn: string; path: string }>;
        for (const r of rows) {
          orphanSymbols.push({
            name: r.name,
            type: "ORPHAN_SYMBOL",
            sourceFile: r.path,
            reason: `Symbol has zero incoming call-graph edges (in-degree = 0) from active codebase.`,
          });
        }
        db.close();
      } catch {
        // SQLite query fallback
      }
    }

    if (deadDeclaredEvents.length > 0) {
      quirks.push(`Found ${deadDeclaredEvents.length} dead socket event(s) declared in contracts but never triggered in runtime.`);
    }
    if (undeclaredEvents.length > 0) {
      quirks.push(`Found ${undeclaredEvents.length} undeclared socket event(s) emitted without formal TypeScript interface typing.`);
    }
    if (orphanSymbols.length > 0) {
      quirks.push(`Detected ${orphanSymbols.length} orphan function/method symbol(s) with zero callers.`);
    }

    return {
      timestamp: new Date().toISOString(),
      repositoryPath: this.repoPath,
      totalDeadCodeCount: deadDeclaredEvents.length + undeclaredEvents.length + orphanSymbols.length,
      deadDeclaredEvents,
      undeclaredEvents,
      orphanSymbols,
      quirksSummary: quirks,
    };
  }
}
