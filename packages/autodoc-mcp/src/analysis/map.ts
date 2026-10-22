import type { Evidence, Fact, InventoryFile, Relation, SnapshotMetadata, SnapshotPage } from './contracts.js';
import type { SnapshotContext } from './snapshot.js';
import { readInventoryFiles } from './source-reader.js';

export type ArchitectureMapKind = 'context' | 'structure' | 'imports' | 'entrypoints' | 'infrastructure' | 'code';
export type MapNodeState = 'inventory' | 'confirmed' | 'hypothesis';

export interface MapNode {
  id: string;
  label: string;
  kind: string;
  state: MapNodeState;
  evidenceIds: string[];
  attributes?: Record<string, unknown>;
}

export interface MapRelation {
  id: string;
  fromId: string;
  toId: string | null;
  kind: string;
  resolution: Relation['resolution'];
  state: MapNodeState;
  candidateIds: string[];
  evidenceIds: string[];
}

export interface MapProjection {
  scanId: string;
  repositoryRoot: string;
  kind: ArchitectureMapKind;
  coverage: SnapshotMetadata['coverage'][string];
  nodes: MapNode[];
  relations: MapRelation[];
}

export interface SnapshotTrace {
  path: string[];
  sink: string | null;
  taintStatus: 'CONFIRMED' | 'UNKNOWN';
  status: 'OK' | 'UNKNOWN';
  scanId: string;
}

type SnapshotItem = Fact | Evidence | InventoryFile | Relation;

function readCollection(context: SnapshotContext, collection: SnapshotPage['collection']): SnapshotItem[] {
  const items: SnapshotItem[] = [];
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const page = context.readPage(collection, cursor, 500);
    if (page.scanId !== context.scanId || page.repositoryRoot !== context.repositoryRoot || page.collection !== collection) {
      throw new Error(`${collection} page does not belong to the pinned snapshot`);
    }
    items.push(...page.items as SnapshotItem[]);
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor)) throw new Error(`${collection} pagination returned a repeated cursor`);
    if (cursor) visited.add(cursor);
  } while (cursor);
  return items;
}

function combineCoverage(context: SnapshotContext): SnapshotMetadata['coverage'][string] {
  const entries = Object.values(context.metadata.coverage);
  if (entries.length === 0) return { state: 'unsupported', examined: 0, excluded: 0, diagnostics: [{ code: 'NO_COVERAGE_METADATA' }] };
  const states = new Set(entries.map((entry) => entry.state));
  const state: SnapshotMetadata['coverage'][string]['state'] = states.has('partial') ? 'partial'
    : states.has('not_scanned') ? 'not_scanned'
      : states.has('unsupported') ? 'unsupported' : 'complete';
  const diagnosticsByKey = new Map<string, SnapshotMetadata['coverage'][string]['diagnostics'][number]>();
  for (const entry of entries) for (const diagnostic of entry.diagnostics) diagnosticsByKey.set(`${diagnostic.code}\0${diagnostic.path ?? ''}`, diagnostic);
  return {
    state,
    examined: entries.reduce((sum, entry) => sum + entry.examined, 0),
    excluded: entries.reduce((sum, entry) => sum + entry.excluded, 0),
    diagnostics: [...diagnosticsByKey.values()],
  };
}

function evidenceForPath(path: string, evidence: Evidence[]): string[] {
  return evidence.filter((item) => item.path === path).map((item) => item.id).sort();
}

function semanticNode(fact: Fact, evidenceIds: Set<string>): MapNode | undefined {
  const validEvidence = fact.evidenceIds.filter((id) => evidenceIds.has(id));
  if (validEvidence.length === 0) return undefined;
  const label = typeof fact.attributes.name === 'string' ? fact.attributes.name
    : typeof fact.attributes.path === 'string' ? fact.attributes.path : fact.kind;
  return { id: fact.id, label, kind: fact.kind, state: 'confirmed', evidenceIds: validEvidence, attributes: fact.attributes };
}

function projectRelation(relation: Relation, evidenceIds: Set<string>): MapRelation {
  const validEvidence = relation.evidenceIds.filter((id) => evidenceIds.has(id));
  const confirmed = relation.resolution === 'resolved' && Boolean(relation.toId) && validEvidence.length > 0;
  return {
    id: relation.id, fromId: relation.fromId, toId: relation.toId ?? null, kind: relation.kind,
    resolution: relation.resolution, state: confirmed ? 'confirmed' : 'hypothesis',
    candidateIds: relation.candidateIds, evidenceIds: validEvidence,
  };
}

function fileNode(file: InventoryFile, evidence: Evidence[]): MapNode {
  return { id: `file:${file.path}`, label: file.path, kind: `file:${file.category}`, state: 'inventory', evidenceIds: evidenceForPath(file.path, evidence), attributes: { category: file.category, support: file.support, contentSha256: file.contentSha256 ?? null } };
}

function matchesKind(kind: string, pattern: RegExp): boolean { return pattern.test(kind.toLowerCase()); }

/** Projects one map from a context whose pages remain pinned to a single scan. */
export function buildArchitectureMap(context: SnapshotContext, kind: ArchitectureMapKind): MapProjection {
  const files = readInventoryFiles(context).filter((file) => !file.excludedReason);
  const facts = readCollection(context, 'facts') as Fact[];
  const evidence = readCollection(context, 'evidence') as Evidence[];
  const relations = readCollection(context, 'relations') as Relation[];
  const evidenceIds = new Set(evidence.map((item) => item.id));
  let nodes: MapNode[] = [];
  let projectedRelations: MapRelation[] = [];

  if (kind === 'context') {
    // The root and generation are snapshot metadata. This models the repository
    // as one internal system without inventing external actors or dependencies.
    const label = context.repositoryRoot.split(/[\\/]/).filter(Boolean).at(-1) || context.repositoryRoot;
    nodes = [{
      id: `repository:${context.repositoryRoot}`,
      label,
      kind: 'repository',
      state: 'inventory',
      evidenceIds: [],
      attributes: { repositoryRoot: context.repositoryRoot, scanId: context.scanId },
    }];
  } else if (kind === 'structure') {
    nodes = files.map((file) => fileNode(file, evidence));
  } else if (kind === 'infrastructure') {
    nodes = files.filter((file) => file.category === 'infra').map((file) => fileNode(file, evidence));
    nodes.push(...facts.filter((fact) => matchesKind(fact.kind, /infrastructure|container|deployment/))
      .map((fact) => semanticNode(fact, evidenceIds)).filter((node): node is MapNode => Boolean(node)));
    projectedRelations = relations.filter((relation) => matchesKind(relation.kind, /infra|container|deploy|configures/))
      .map((relation) => projectRelation(relation, evidenceIds));
  } else if (kind === 'entrypoints') {
    nodes = facts.filter((fact) => matchesKind(fact.kind, /entry.?point/))
      .map((fact) => semanticNode(fact, evidenceIds)).filter((node): node is MapNode => Boolean(node));
  } else if (kind === 'imports') {
    nodes = files.map((file) => fileNode(file, evidence));
    projectedRelations = relations.filter((relation) => matchesKind(relation.kind, /import|depends_on|dependency/))
      .map((relation) => projectRelation(relation, evidenceIds));
  } else {
    nodes = facts.filter((fact) => matchesKind(fact.kind, /function|method|class|interface|struct|symbol/))
      .map((fact) => semanticNode(fact, evidenceIds)).filter((node): node is MapNode => Boolean(node));
    projectedRelations = relations.filter((relation) => matchesKind(relation.kind, /calls|call|data.flow/))
      .map((relation) => projectRelation(relation, evidenceIds));
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  projectedRelations.sort((a, b) => a.id.localeCompare(b.id));
  return { scanId: context.scanId, repositoryRoot: context.repositoryRoot, kind, coverage: combineCoverage(context), nodes, relations: projectedRelations };
}

/** Returns the shortest evidence-backed path, or an explicit UNKNOWN result. */
export function traceSnapshotPath(context: SnapshotContext, sourceId: string, sinkId: string): SnapshotTrace {
  const evidenceIds = new Set((readCollection(context, 'evidence') as Evidence[]).map((item) => item.id));
  const relations = readCollection(context, 'relations') as Relation[];
  const adjacency = new Map<string, string[]>();
  for (const relation of relations) {
    if (!relation.toId || relation.resolution !== 'resolved' || relation.evidenceIds.length === 0 || !relation.evidenceIds.every((id) => evidenceIds.has(id))) continue;
    if (!matchesKind(relation.kind, /calls|call|data.flow/)) continue;
    const neighbors = adjacency.get(relation.fromId) ?? [];
    if (!neighbors.includes(relation.toId)) neighbors.push(relation.toId);
    adjacency.set(relation.fromId, neighbors);
  }
  const queue: Array<{ id: string; path: string[] }> = [{ id: sourceId, path: [sourceId] }];
  const visited = new Set([sourceId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === sinkId && current.path.length > 1) return { path: current.path, sink: sinkId, taintStatus: 'UNKNOWN', status: 'OK', scanId: context.scanId };
    for (const next of adjacency.get(current.id) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push({ id: next, path: [...current.path, next] });
    }
  }
  return { path: [], sink: null, taintStatus: 'UNKNOWN', status: 'UNKNOWN', scanId: context.scanId };
}
