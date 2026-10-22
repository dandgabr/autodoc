import { RealtimeAnalyzer } from "../realtime/index.js";
import type { SnapshotContext } from "../../analysis/snapshot.js";
import type { Evidence, Fact, Relation, SnapshotPage } from "../../analysis/contracts.js";

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
  candidateCount: number;
  coverage: "complete" | "partial" | "not_scanned" | "unsupported";
  scanId?: string;
  diagnostics: string[];
  deadDeclaredEvents: DeadCodeItem[];
  undeclaredEvents: DeadCodeItem[];
  orphanSymbols: DeadCodeItem[];
  quirksSummary: string[];
}

export class HonestyAnalyzer {
  private repoPath: string;
  private snapshot?: SnapshotContext;
  private realtimeAnalyzer: RealtimeAnalyzer;

  constructor(repoPath: string = process.cwd(), snapshot?: SnapshotContext) {
    this.repoPath = repoPath;
    this.snapshot = snapshot;
    this.realtimeAnalyzer = new RealtimeAnalyzer(repoPath, { snapshot });
  }

  private readSnapshotCollection(context: SnapshotContext, collection: SnapshotPage["collection"]): Array<Fact | Evidence | Relation> {
    const items: Array<Fact | Evidence | Relation> = [];
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const page = context.readPage(collection, cursor, 500);
      if (page.scanId !== context.scanId || page.repositoryRoot !== context.repositoryRoot || page.collection !== collection) {
        throw new Error(`${collection} page does not belong to the pinned snapshot`);
      }
      items.push(...page.items as Array<Fact | Evidence | Relation>);
      cursor = page.nextCursor;
      if (cursor && visited.has(cursor)) throw new Error(`${collection} pagination returned a repeated cursor`);
      if (cursor) visited.add(cursor);
    } while (cursor);
    return items;
  }

  public generateHonestyReport(): HonestyReport {
    const deadDeclaredEvents: DeadCodeItem[] = [];
    const undeclaredEvents: DeadCodeItem[] = [];
    const orphanSymbols: DeadCodeItem[] = [];
    const quirks: string[] = [];

    // 1. Analyze Socket Contracts vs. Actual Emits & Listens
    const allSocketEvents = this.realtimeAnalyzer.discoverSocketContracts("ALL", Number.MAX_SAFE_INTEGER);
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

    const diagnostics: string[] = [];
    if (this.snapshot) {
      const facts = this.readSnapshotCollection(this.snapshot, "facts") as Fact[];
      const evidence = this.readSnapshotCollection(this.snapshot, "evidence") as Evidence[];
      const relations = this.readSnapshotCollection(this.snapshot, "relations") as Relation[];
      const evidenceIds = new Set(evidence.map((item) => item.id));
      const incoming = new Set(relations.filter((relation) => relation.resolution === "resolved" && relation.toId &&
        relation.evidenceIds.length > 0 && relation.evidenceIds.every((id) => evidenceIds.has(id))).map((relation) => relation.toId!));
      for (const fact of facts) {
        if (!/^(function|method)$/i.test(fact.kind) || fact.evidenceIds.length === 0 || !fact.evidenceIds.every((id) => evidenceIds.has(id)) || incoming.has(fact.id)) continue;
        const name = typeof fact.attributes.name === "string" ? fact.attributes.name : fact.id;
        const sourceFile = typeof fact.attributes.path === "string" ? fact.attributes.path : evidence.find((item) => fact.evidenceIds.includes(item.id))?.path ?? "unknown";
        if (["main", "start", "init", "index", "run", "handler"].includes(name.toLowerCase())) continue;
        orphanSymbols.push({
          name,
          type: "ORPHAN_SYMBOL",
          sourceFile,
          reason: "No evidence-backed incoming call relation was found in this scan; exports, callbacks, dynamic dispatch, or incomplete coverage may explain this candidate.",
        });
      }
      if (facts.length === 0) diagnostics.push("The snapshot does not persist symbol facts; orphan-symbol analysis is unsupported for this scan.");
    } else {
      diagnostics.push("No pinned scan snapshot was supplied; symbol candidates are not read from mutable cache rows.");
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
      candidateCount: deadDeclaredEvents.length + undeclaredEvents.length + orphanSymbols.length,
      coverage: this.snapshot ? "partial" : "not_scanned",
      ...(this.snapshot ? { scanId: this.snapshot.scanId } : {}),
      diagnostics,
      deadDeclaredEvents,
      undeclaredEvents,
      orphanSymbols,
      quirksSummary: quirks,
    };
  }
}
