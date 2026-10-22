import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHITECTURE_MAP_RESOURCE_TEMPLATES, AutoDocTools } from '../src/tools/handlers.js';
import { I18nManager } from '../src/i18n/index.js';
import type { NativeBinding } from '../src/binding.js';
import type { SnapshotPage } from '../src/analysis/contracts.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function createFixtureBinding(repoPath: string, collections: Partial<Record<SnapshotPage['collection'], unknown[]>> = {}): NativeBinding {
  const repositoryRoot = resolve(repoPath);
  const scanId = 'scan-map-1';
  const coverage = { state: 'complete', examined: 4, excluded: 0, diagnostics: [] };
  const items = { files: [], facts: [], evidence: [], relations: [], ...collections };
  return {
    initLogger() {}, ping: () => ({ traceId: '', status: 'OK', version: '', rustcVersion: '', timestampMs: 0 }),
    triggerPanicTest: () => '', acquireExportLockNative: () => '', releaseExportLockNative() {},
    readRepositorySnapshotNative: (root, requestedScan) => JSON.stringify({
      contractVersion: 2, schemaVersion: 5, scanId: requestedScan ?? scanId, repositoryRoot: root,
      createdAt: '2026-10-22T10:00:00.000Z', extractorVersions: { test: '1' }, coverage: { overall: coverage },
      latestAttempt: null, freshness: 'verified',
      totals: { facts: items.facts.length, evidence: items.evidence.length, relations: items.relations.length, files: items.files.length },
    }),
    readSnapshotPageNative: (_root, requestedScan, collection, cursor, limit) => {
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      const collectionItems = items[collection] as unknown[];
      const pageItems = collectionItems.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      return JSON.stringify({
        contractVersion: 2, schemaVersion: 5, scanId: requestedScan, repositoryRoot, collection,
        items: pageItems, total: collectionItems.length,
        nextCursor: nextOffset < collectionItems.length ? String(nextOffset) : null,
        coverage,
      });
    },
  } as NativeBinding;
}

function evidence(id: string, path: string) {
  return { id, path, contentSha256: 'a'.repeat(64), lineStart: 1, lineEnd: 1, extractor: 'fixture-ast', method: 'ast' };
}

function createVersionedFixtureBinding(repoPath: string): NativeBinding {
  const repositoryRoot = resolve(repoPath);
  const coverage = { state: 'complete', examined: 1, excluded: 0, diagnostics: [] };
  const versions: Record<string, Record<SnapshotPage['collection'], unknown[]>> = {
    'scan-old': { files: [], facts: [{ id: 'old-symbol', kind: 'function', evidenceIds: ['ev-old'], attributes: { name: 'oldFunction' } }], evidence: [evidence('ev-old', 'src/old.ts')], relations: [] },
    'scan-new': { files: [], facts: [{ id: 'new-symbol', kind: 'function', evidenceIds: ['ev-new'], attributes: { name: 'newFunction' } }], evidence: [evidence('ev-new', 'src/new.ts')], relations: [] },
  };
  let activeScanId = 'scan-old';
  return {
    initLogger() {}, ping: () => ({ traceId: '', status: 'OK', version: '', rustcVersion: '', timestampMs: 0 }),
    triggerPanicTest: () => '', acquireExportLockNative: () => '', releaseExportLockNative() {},
    readRepositorySnapshotNative: (root, requestedScan) => {
      const scanId = requestedScan ?? activeScanId;
      if (!versions[scanId]) throw new Error(`SNAPSHOT_UNAVAILABLE: scan ${scanId} is expired`);
      const selected = versions[scanId];
      activeScanId = 'scan-new'; // Simulate publication while concurrent readers are loading.
      return JSON.stringify({
        contractVersion: 2, schemaVersion: 5, scanId, repositoryRoot: root,
        createdAt: '2026-10-22T10:00:00.000Z', extractorVersions: {}, coverage: { overall: coverage },
        latestAttempt: null, freshness: 'verified',
        totals: { facts: selected.facts.length, evidence: selected.evidence.length, relations: selected.relations.length, files: selected.files.length },
      });
    },
    readSnapshotPageNative: (root, scanId, collection, cursor, limit) => {
      const selected = versions[scanId];
      if (!selected) throw new Error(`SNAPSHOT_UNAVAILABLE: scan ${scanId} is expired`);
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      const collectionItems = selected[collection];
      const pageItems = collectionItems.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      return JSON.stringify({ contractVersion: 2, schemaVersion: 5, scanId, repositoryRoot: root, collection, items: pageItems, total: collectionItems.length, nextCursor: nextOffset < collectionItems.length ? String(nextOffset) : null, coverage });
    },
  } as NativeBinding;
}

describe('snapshot map integration', () => {
  it('advertises backwards-compatible C4 URIs and scan-pinned map templates', () => {
    expect(ARCHITECTURE_MAP_RESOURCE_TEMPLATES).toEqual(expect.arrayContaining([
      expect.objectContaining({ uriTemplate: 'code://c4/{level}{?scan_id}' }),
      expect.objectContaining({ uriTemplate: 'code://map/{kind}{?scan_id}' }),
      expect.objectContaining({ uriTemplate: 'code://graph/callgraph{?scan_id}' }),
    ]));
  });

  it('keeps concurrent C4 and resource reads pinned when the active scan changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-map-pinned-'));
    roots.push(root);
    const tools = new AutoDocTools(createVersionedFixtureBinding(root), new I18nManager('en-US'));
    const [diagram, resource] = await Promise.all([
      tools.handleGetC4Diagram({ repoPath: root, level: 4, scan_id: 'scan-old' }),
      tools.handleReadMapResource('code://map/code?scan_id=scan-old', root),
    ]);
    expect(diagram).toMatchObject({ scanId: 'scan-old', projection: { nodes: [expect.objectContaining({ id: 'old-symbol' })] } });
    expect(resource).toMatchObject({ requestedScanId: 'scan-old', scanId: 'scan-old', projection: { nodes: [expect.objectContaining({ id: 'old-symbol' })] } });
  });

  it('returns SNAPSHOT_UNAVAILABLE for expired scan IDs on tools and resources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-map-stale-'));
    roots.push(root);
    const tools = new AutoDocTools(createVersionedFixtureBinding(root), new I18nManager('en-US'));
    expect(await tools.handleGetC4Diagram({ repoPath: root, level: 1, scan_id: 'expired' })).toMatchObject({ status: 'SNAPSHOT_UNAVAILABLE', scanId: null, diagram: null });
    expect(await tools.handleReadMapResource('code://c4/1?scan_id=expired', root)).toMatchObject({ status: 'SNAPSHOT_UNAVAILABLE', scanId: null, projection: null });
  });

  it('serves C4 and call graph resources from the exact projections returned by tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-map-parity-'));
    roots.push(root);
    const tools = new AutoDocTools(createFixtureBinding(root, {
      files: [{ path: 'Dockerfile', category: 'infra', support: 'metadata', contentSha256: null, excludedReason: null, readError: null }],
      facts: [{ id: 'symbol-a', kind: 'function', attributes: { name: 'A' }, evidenceIds: ['ev-a'] }],
      evidence: [evidence('ev-a', 'src/a.ts'), evidence('ev-ab', 'src/a.ts')],
      relations: [{ id: 'call-a-b', fromId: 'A', toId: 'B', kind: 'calls', resolution: 'resolved', candidateIds: [], evidenceIds: ['ev-ab'] }],
    }), new I18nManager('en-US'));

    const c4 = await tools.handleGetC4Diagram({ repoPath: root, level: 2 });
    const c4Resource = await tools.handleReadMapResource('code://c4/2', root);
    expect(c4).toMatchObject({ scanId: 'scan-map-1', repositoryRoot: resolve(root), status: 'PARTIAL' });
    expect(c4Resource).toMatchObject({ uri: 'code://c4/2', scanId: c4.scanId, projection: c4.projection });

    const contextDiagram = await tools.handleGetC4Diagram({ repoPath: root, level: 1, scan_id: 'scan-map-1' });
    const contextResource = await tools.handleReadMapResource('code://c4/1?scan_id=scan-map-1', root);
    expect(contextDiagram).toMatchObject({ scanId: 'scan-map-1', projection: contextResource.projection });
    expect(contextDiagram.diagram).toContain('C4Context');

    const graph = await tools.handleGetC4Diagram({ repoPath: root, level: 4 });
    const graphResource = await tools.handleReadMapResource('code://graph/callgraph', root);
    expect(graphResource).toMatchObject({ uri: 'code://graph/callgraph', scanId: graph.scanId, projection: graph.projection });
  });

  it('returns evidence-backed paths and unknown status when relation evidence is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-trace-snapshot-'));
    roots.push(root);
    const relations = [
      { id: 'a-b', fromId: 'A', toId: 'B', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ev-ab'] },
      { id: 'a-c', fromId: 'A', toId: 'C', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ev-ac'] },
      { id: 'c-a', fromId: 'C', toId: 'A', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ev-ca'] },
      { id: 'a-ghost', fromId: 'A', toId: 'G', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['missing'] },
      { id: 'a-d', fromId: 'A', toId: 'D', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ev-ad'] },
      { id: 'd-f', fromId: 'D', toId: 'F', kind: 'data_flow', resolution: 'resolved', candidateIds: [], evidenceIds: ['ev-df'] },
    ];
    const tools = new AutoDocTools(createFixtureBinding(root, {
      evidence: [evidence('ev-ab', 'a.ts'), evidence('ev-ac', 'a.ts'), evidence('ev-ca', 'c.ts'), evidence('ev-ad', 'a.ts'), evidence('ev-df', 'd.ts')], relations,
    }), new I18nManager('en-US'));

    const branch = await tools.handleTraceDataFlow({ repoPath: root, entrypoint_symbol: 'A', target_sink: 'C', max_depth: 2 });
    expect(branch).toMatchObject({ scanId: 'scan-map-1', path: ['A', 'C'], sink: 'C', status: 'SUCCESS', taintStatus: 'UNKNOWN' });
    const unsupported = await tools.handleTraceDataFlow({ repoPath: root, entrypoint_symbol: 'A', target_sink: 'G' });
    expect(unsupported).toMatchObject({ path: [], sink: null, status: 'UNKNOWN', taintStatus: 'UNKNOWN' });
    const beyondDepth = await tools.handleTraceDataFlow({ repoPath: root, entrypoint_symbol: 'A', target_sink: 'F', max_depth: 1 });
    expect(beyondDepth).toMatchObject({ path: [], sink: null, status: 'PARTIAL', taintStatus: 'UNKNOWN' });
  });

  it('reports missing snapshots explicitly for map resources and trace tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-no-snapshot-'));
    roots.push(root);
    const binding = createFixtureBinding(root);
    binding.readRepositorySnapshotNative = () => { throw new Error('NOT_SCANNED: no active generation'); };
    const tools = new AutoDocTools(binding, new I18nManager('en-US'));
    expect(await tools.handleReadMapResource('code://c4/2', root)).toMatchObject({ status: 'NOT_SCANNED', scanId: null, projection: null });
    expect(await tools.handleTraceDataFlow({ repoPath: root, entrypoint_symbol: 'A' })).toMatchObject({ status: 'NOT_SCANNED', scanId: null, path: [], sink: null, taintStatus: 'UNKNOWN' });
  });
});
