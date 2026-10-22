import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchitectureAnalyzer } from '../src/analyzers/architecture.js';
import { registerRepositoryCachePath } from '../src/analysis/cache-state.js';
import { buildArchitectureMap, traceSnapshotPath } from '../src/analysis/map.js';
import { inferProjectProfile } from '../src/analysis/profile.js';
import type { SnapshotContext } from '../src/analysis/snapshot.js';
import type { SnapshotPage } from '../src/analysis/contracts.js';
import { DiagramRenderer } from '../src/diagrams/renderer.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('project maps', () => {
  const snapshotContext = (input: {
    files?: Array<Record<string, unknown>>;
    facts?: Array<Record<string, unknown>>;
    evidence?: Array<Record<string, unknown>>;
    relations?: Array<Record<string, unknown>>;
  }): SnapshotContext => {
    const repositoryRoot = '/repo';
    const coverage = { state: 'complete' as const, examined: 4, excluded: 0, diagnostics: [] };
    const pages: Record<SnapshotPage['collection'], Array<Record<string, unknown>>> = {
      files: input.files ?? [], facts: input.facts ?? [], evidence: input.evidence ?? [], relations: input.relations ?? [],
    };
    return {
      repositoryRoot, scanId: 'scan-g1',
      metadata: {
        contractVersion: 2, schemaVersion: 5, scanId: 'scan-g1', repositoryRoot,
        createdAt: '2026-10-22T10:00:00.000Z', extractorVersions: {}, coverage: { source: coverage },
        latestAttempt: null, freshness: 'verified', totals: { facts: pages.facts.length, evidence: pages.evidence.length, relations: pages.relations.length, files: pages.files.length },
      },
      readPage(collection, cursor = null) {
        const offset = cursor ? Number(cursor) : 0;
        const items = pages[collection].slice(offset, offset + 500);
        const next = offset + items.length < pages[collection].length ? String(offset + items.length) : null;
        return { contractVersion: 2, schemaVersion: 5, scanId: 'scan-g1', repositoryRoot, collection, items, total: pages[collection].length, nextCursor: next, coverage } as SnapshotPage;
      },
    };
  };

  const evidence = (id: string, path: string) => ({ id, path, contentSha256: 'a'.repeat(64), lineStart: 1, lineEnd: 1, extractor: 'test-ast', method: 'ast' });

  it('projects files, symbols, imports and infra facts from one pinned generation', () => {
    const context = snapshotContext({
      files: [
        { path: 'index.html', category: 'markup', support: 'metadata', contentSha256: null },
        { path: 'src/a.ts', category: 'source', support: 'ast', contentSha256: 'a'.repeat(64) },
        { path: 'Dockerfile', category: 'infra', support: 'metadata', contentSha256: null },
      ],
      facts: [
        { id: 'symbol-a', kind: 'function', evidenceIds: ['ev-a'], attributes: { name: 'A', path: 'src/a.ts' } },
        { id: 'symbol-b', kind: 'function', evidenceIds: ['ev-b'], attributes: { name: 'B', path: 'src/b.ts' } },
        { id: 'entry-a', kind: 'entrypoint', evidenceIds: ['ev-a'], attributes: { symbolId: 'symbol-a' } },
      ],
      evidence: [evidence('ev-a', 'src/a.ts'), evidence('ev-b', 'src/b.ts'), evidence('ev-import', 'src/a.ts'), evidence('ev-infra', 'Dockerfile')],
      relations: [
        { id: 'import-a-b', fromId: 'file:src/a.ts', toId: 'file:src/b.ts', kind: 'imports', resolution: 'resolved', candidateIds: [], evidenceIds: ['ev-import'] },
        { id: 'infra-docker', fromId: 'file:Dockerfile', toId: null, kind: 'declares_infrastructure', resolution: 'unresolved', candidateIds: [], evidenceIds: ['ev-infra'] },
      ],
    });

    const structure = buildArchitectureMap(context, 'structure');
    const imports = buildArchitectureMap(context, 'imports');
    const entrypoints = buildArchitectureMap(context, 'entrypoints');
    const infrastructure = buildArchitectureMap(context, 'infrastructure');
    expect(structure).toMatchObject({ scanId: 'scan-g1', repositoryRoot: '/repo' });
    expect(structure.nodes.map((node) => node.id)).toContain('file:src/a.ts');
    expect(imports.relations.map((relation) => relation.id)).toEqual(['import-a-b']);
    expect(imports.relations[0].evidenceIds).toEqual(['ev-import']);
    expect(entrypoints.nodes.map((node) => node.id)).toEqual(['entry-a']);
    expect(infrastructure.nodes.map((node) => node.id)).toEqual(['file:Dockerfile']);
    expect(infrastructure.relations).toMatchObject([{ id: 'infra-docker', state: 'hypothesis', toId: null }]);
    expect(infrastructure.relations[0].evidenceIds).toEqual(['ev-infra']);
  });

  it('projects C4 context from snapshot metadata without inventing external actors', () => {
    const context = snapshotContext({ files: [{ path: 'src/main.ts', category: 'source', support: 'ast', contentSha256: 'a'.repeat(64) }] });
    const projection = buildArchitectureMap(context, 'context');
    expect(projection).toMatchObject({ scanId: 'scan-g1', repositoryRoot: '/repo', kind: 'context' });
    expect(projection.nodes).toEqual([expect.objectContaining({ id: 'repository:/repo', label: 'repo', kind: 'repository', state: 'inventory', evidenceIds: [] })]);
    const diagram = DiagramRenderer.renderC4Mermaid({ level: 1, title: 'repo context', nodes: projection.nodes.map((node) => ({ id: node.id, label: node.label, desc: node.kind, type: 'system', state: node.state, evidenceIds: node.evidenceIds })) });
    expect(diagram).toContain('C4Context');
    expect(diagram).toContain('System(repository__repo');
    expect(diagram).not.toContain('Person(');
    expect(diagram).not.toContain('System_Ext(');
  });

  it('adapts graph levels 3 and 4 from the injected snapshot context', () => {
    const context = snapshotContext({
      files: [{ path: 'src/a.ts', category: 'source', support: 'ast', contentSha256: 'a'.repeat(64) }],
      facts: [{ id: 'symbol-a', kind: 'function', evidenceIds: ['ev-a'], attributes: { name: 'A', path: 'src/a.ts' } }],
      evidence: [evidence('ev-a', 'src/a.ts')],
    });
    const analyzer = new ArchitectureAnalyzer('/repo', context);
    expect(analyzer.getArchitectureGraph(3)).toMatchObject({ level: 3, scanId: 'scan-g1', repositoryRoot: '/repo' });
    expect(analyzer.getArchitectureGraph(3).nodes[0]).toMatchObject({ id: 'file:src/a.ts', state: 'inventory' });
    expect(analyzer.getArchitectureGraph(4).nodes[0]).toMatchObject({ id: 'symbol-a', evidenceIds: ['ev-a'], state: 'confirmed' });
  });

  it('traces only evidence-backed resolved paths, handles branches and cycles, and reports unknown without evidence', () => {
    const base = [evidence('ab', 'a.ts'), evidence('ac', 'a.ts'), evidence('bc', 'b.ts'), evidence('ca', 'c.ts')];
    const context = snapshotContext({
      evidence: base,
      relations: [
        { id: 'a-b', fromId: 'A', toId: 'B', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ab'] },
        { id: 'a-c', fromId: 'A', toId: 'C', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ac'] },
        { id: 'b-c', fromId: 'B', toId: 'C', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['bc'] },
        { id: 'c-a', fromId: 'C', toId: 'A', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ca'] },
        { id: 'a-ghost', fromId: 'A', toId: 'G', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['missing'] },
      ],
    });
    expect(traceSnapshotPath(context, 'A', 'B')).toMatchObject({ path: ['A', 'B'], sink: 'B', taintStatus: 'UNKNOWN' });
    expect(traceSnapshotPath(context, 'A', 'C')).toMatchObject({ path: ['A', 'C'], sink: 'C', taintStatus: 'UNKNOWN' });
    expect(traceSnapshotPath(context, 'A', 'A')).toMatchObject({ path: [], sink: null, taintStatus: 'UNKNOWN' });
    expect(traceSnapshotPath(context, 'missing', 'C')).toMatchObject({ path: [], sink: null, taintStatus: 'UNKNOWN' });
    expect(traceSnapshotPath(context, 'A', 'G')).toMatchObject({ path: [], sink: null, taintStatus: 'UNKNOWN' });
  });

  it('keeps profile classification explicitly hypothetical when inferred from filenames', () => {
    const profile = inferProjectProfile(snapshotContext({
      files: [
        { path: 'index.html', category: 'markup', support: 'metadata', contentSha256: null },
        { path: 'css/site.css', category: 'style', support: 'metadata', contentSha256: null },
      ],
    }));
    expect(profile).toMatchObject({ profile: 'static_site', state: 'hypothesis' });
  });

  it('renders semantic identifiers, evidence identifiers and state with normal escaping', () => {
    const diagram = DiagramRenderer.renderC4Mermaid({
      level: 3,
      title: 'Pinned map',
      nodes: [{ id: 'file:src/a.ts', label: 'A <module>', desc: 'Source', type: 'component', state: 'confirmed', evidenceIds: ['ev-a'] }],
      edges: [{ id: 'rel-a-b', from: 'file:src/a.ts', to: 'file:src/b.ts', label: 'imports', state: 'confirmed', evidenceIds: ['ev-import'] }],
    });
    expect(diagram).toContain('ID: file:src/a.ts');
    expect(diagram).toContain('State: confirmed');
    expect(diagram).toContain('Evidence: ev-a');
    expect(diagram).toContain('A &lt;module&gt;');
    expect(diagram).toContain('ID: rel-a-b');
  });

  it('maps root and nested files and keeps file maps distinct from code maps', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-map-'));
    roots.push(root);
    mkdirSync(join(root, '.autodoc'));
    const db = new DatabaseSync(join(root, '.autodoc', 'cache.db'));
    db.exec(`CREATE TABLE files(file_id INTEGER PRIMARY KEY, path TEXT, language TEXT);
      CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, kind TEXT, fqsn TEXT, cyclomatic_complexity INTEGER, line_start INTEGER, line_end INTEGER);
      CREATE TABLE edges(caller_id INTEGER, callee_id INTEGER, edge_kind TEXT, weight REAL);
      CREATE TABLE scan_state(singleton INTEGER PRIMARY KEY, active_scan_id TEXT, latest_attempt_id TEXT);
      INSERT INTO scan_state VALUES (1, 'scan-1', 'scan-1');`);
    db.prepare('INSERT INTO files VALUES (?, ?, ?)').run(1, 'js/game.js', 'js');
    db.prepare('INSERT INTO files VALUES (?, ?, ?)').run(2, 'main.py', 'py');
    db.prepare('INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, 'startGame', 'function', 'js/game.js::startGame', 1, 1, 3);
    db.prepare('INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(2, 2, 'main', 'function', 'main.py::main', 1, 1, 2);
    db.close();
    writeFileSync(join(root, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx:1.27\n');

    const analyzer = new ArchitectureAnalyzer(root);
    const fileMap = analyzer.getArchitectureGraph(3);
    const codeMap = analyzer.getArchitectureGraph(4);
    const contextMap = analyzer.getArchitectureGraph(1);
    const containerMap = analyzer.getArchitectureGraph(2);
    expect(fileMap.level).toBe(3);
    expect(fileMap.nodes.map((node) => node.label)).toEqual(['js/game.js', 'main.py']);
    expect(codeMap.level).toBe(4);
    expect(codeMap.nodes.map((node) => node.label)).toContain('startGame');
    expect(codeMap.nodes.map((node) => node.label)).toContain('main');
    expect(codeMap.title).not.toEqual(fileMap.title);
    expect(contextMap.nodes).toHaveLength(1);
    expect(contextMap.nodes[0].label).toMatch(/^autodoc-map-/);
    expect(contextMap.nodes.some((node) => /player|user/i.test(node.label))).toBe(false);
    expect(containerMap.nodes).toContainEqual(expect.objectContaining({
      id: 'service:web', label: 'web', type: 'container', technology: 'nginx:1.27',
    }));
    expect(containerMap.edges).toEqual([]);
  });

  it('does not use legacy cache rows without an active generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-legacy-map-'));
    roots.push(root);
    mkdirSync(join(root, '.autodoc'));
    const db = new DatabaseSync(join(root, '.autodoc', 'cache.db'));
    db.exec(`CREATE TABLE files(file_id INTEGER PRIMARY KEY, path TEXT, language TEXT);
      CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, kind TEXT, fqsn TEXT, cyclomatic_complexity INTEGER, line_start INTEGER, line_end INTEGER);
      CREATE TABLE edges(caller_id INTEGER, callee_id INTEGER, edge_kind TEXT, weight REAL);
      INSERT INTO files VALUES (1, 'old.rs', 'rs');
      INSERT INTO symbols VALUES (1, 1, 'stale', 'function', 'old.rs::stale', 1, 1, 1);`);
    db.close();
    expect(new ArchitectureAnalyzer(root).getArchitectureGraph(4).nodes).toEqual([]);
  });

  it('uses the cache location returned by a successful scan when it is outside the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-xdg-map-'));
    const cacheRoot = mkdtempSync(join(tmpdir(), 'autodoc-xdg-cache-'));
    roots.push(root, cacheRoot);
    const cachePath = join(cacheRoot, 'cache.db');
    const db = new DatabaseSync(cachePath);
    db.exec(`CREATE TABLE files(file_id INTEGER PRIMARY KEY, path TEXT, language TEXT);
      CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, kind TEXT, fqsn TEXT, cyclomatic_complexity INTEGER, line_start INTEGER, line_end INTEGER);
      CREATE TABLE edges(caller_id INTEGER, callee_id INTEGER, edge_kind TEXT, weight REAL);
      CREATE TABLE scan_state(singleton INTEGER PRIMARY KEY, active_scan_id TEXT, latest_attempt_id TEXT);
      INSERT INTO scan_state VALUES (1, 'scan-xdg', 'scan-xdg');
      INSERT INTO files VALUES (1, 'src/main.rs', 'rs');
      INSERT INTO symbols VALUES (1, 1, 'main', 'function', 'src/main.rs::main', 1, 1, 1);`);
    db.close();
    registerRepositoryCachePath(root, cachePath);
    expect(new ArchitectureAnalyzer(root).getArchitectureGraph(4).nodes.map((node) => node.label)).toContain('main');
  });
});
