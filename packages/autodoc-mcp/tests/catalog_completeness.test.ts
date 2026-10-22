import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoDocTools, ListApiContractsSchema, ListSocketContractsSchema } from '../src/tools/handlers.js';
import { I18nManager } from '../src/i18n/index.js';
import { SchemaAnalyzer } from '../src/analyzers/schema/index.js';
import { RestAnalyzer } from '../src/analyzers/rest/index.js';
import { RealtimeAnalyzer } from '../src/analyzers/realtime/index.js';
import { DiataxisGenerator } from '../src/diataxis/generator.js';
import { loadSnapshot } from '../src/analysis/snapshot.js';
import type { NativeBinding } from '../src/binding.js';
import type { SnapshotPage } from '../src/analysis/contracts.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'autodoc-catalog-'));
  roots.push(root);
  writeFileSync(join(root, 'app.js'), Array.from({ length: 201 }, (_, i) => `app.get('/item-${i}', handler);`).join('\n'));
  return root;
}

function snapshotBinding(
  repoPath: string,
  getActiveScan = () => 'scan-1',
  isRetained = (_scanId: string) => true,
  coverageState: 'complete' | 'partial' = 'complete',
  diagnosticCodes: string[] = [],
  onPage?: (collection: SnapshotPage['collection'], cursor: string | null) => void,
): NativeBinding {
  const root = resolve(repoPath);
  const entries: Array<{ path: string; contentSha256: string }> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        entries.push({ path: relative(root, path).split('\\').join('/'), contentSha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  };
  visit(root);
  const coverage = { state: coverageState, examined: entries.length, excluded: 0, diagnostics: diagnosticCodes.map((code) => ({ code })) };
  const makeMetadata = (scanId: string) => ({
    contractVersion: 2 as const, schemaVersion: 5 as const, scanId, repositoryRoot: root,
    createdAt: '2026-10-22T10:00:00.000Z', extractorVersions: { static: '1' }, coverage: { source: coverage },
    latestAttempt: { scanId, state: 'complete' as const }, freshness: 'verified' as const,
    totals: { facts: 0, evidence: 0, relations: 0, files: entries.length },
  });
  return {
    initLogger() {}, ping: () => ({ traceId: '', status: 'OK', version: '', rustcVersion: '', timestampMs: 0 }),
    triggerPanicTest: () => '', acquireExportLockNative: () => '', releaseExportLockNative() {},
    readRepositorySnapshotNative: (_path: string, scanId?: string) => {
      const selected = scanId ?? getActiveScan();
      if (!isRetained(selected)) throw new Error('SNAPSHOT_UNAVAILABLE: generation expired');
      return JSON.stringify(makeMetadata(selected));
    },
    readSnapshotPageNative: (_path: string, scanId: string, collection: SnapshotPage['collection'], cursor: string | null, limit: number) => {
      onPage?.(collection, cursor);
      if (!isRetained(scanId)) throw new Error('SNAPSHOT_UNAVAILABLE: generation expired');
      const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
      let items: unknown[] = [];
      if (collection === 'files') items = entries.map((entry) => ({ ...entry, category: 'source', support: 'heuristic', excludedReason: null, readError: null }));
      const pageItems = items.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      const base = { contractVersion: 2, schemaVersion: 5, scanId, repositoryRoot: root, collection, items: pageItems, total: items.length, nextCursor: nextOffset < items.length ? Buffer.from(String(nextOffset)).toString('base64url') : null, coverage };
      return JSON.stringify(base);
    },
    readVerifiedSourceNative: (_path: string, sourcePath: string, expectedHash: string) => {
      const bytes = readFileSync(join(root, sourcePath));
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== expectedHash) throw new Error(`STALE_SOURCE expected=${expectedHash} actual=${actualHash}`);
      return bytes;
    },
  } as NativeBinding;
}

describe('catalog pagination', () => {
  it('pages through every endpoint without loss or duplication', async () => {
    const repoPath = makeRepo();
    const tools = new AutoDocTools(snapshotBinding(repoPath), new I18nManager('en-US'));
    const ids = new Set<string>();
    let page = await tools.handleListApiContracts({ repoPath, limit: 100 });
    expect(page.total).toBe(201);
    expect(page.truncated).toBe(false);
    expect(page.scanId).toBe('scan-1');
    expect(page.coverage).toMatchObject({ state: 'partial', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'STATIC_EXTRACTOR_COVERAGE' })]) });
    while (true) {
      for (const endpoint of page.items) ids.add(endpoint.endpoint);
      if (!page.nextCursor) break;
      page = await tools.handleListApiContracts({ repoPath, limit: 100, cursor: page.nextCursor });
    }
    expect(ids.size).toBe(201);
  });

  it('rejects a cursor when its filter or repository changes', async () => {
    const repoPath = makeRepo();
    const otherRoot = makeRepo();
    const tools = new AutoDocTools(snapshotBinding(repoPath), new I18nManager('en-US'));
    const first = await tools.handleListApiContracts({ repoPath, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    await expect(tools.handleListApiContracts({ repoPath, limit: 1, cursor: first.nextCursor!, protocolFilter: 'REST' })).rejects.toThrow(/cursor/i);
    await expect(tools.handleListApiContracts({ repoPath: otherRoot, limit: 1, cursor: first.nextCursor! })).rejects.toThrow(/cursor/i);
    await expect(tools.handleListSocketContracts({ repoPath, limit: 1, cursor: first.nextCursor! })).rejects.toThrow(/cursor/i);
    await expect(tools.handleListApiContracts({ repoPath, limit: 1, cursor: first.nextCursor!, scan_id: 'scan-2' })).rejects.toThrow(/cursor/i);
  });

  it('fails explicitly when a cursor generation is no longer retained', async () => {
    const repoPath = makeRepo();
    let activeScan = 'scan-1';
    let scan1Retained = true;
    const tools = new AutoDocTools(snapshotBinding(repoPath, () => activeScan, (scanId) => scanId !== 'scan-1' || scan1Retained), new I18nManager('en-US'));
    const first = await tools.handleListApiContracts({ repoPath, limit: 1 });
    activeScan = 'scan-2';
    scan1Retained = false;
    await expect(tools.handleListApiContracts({ repoPath, limit: 1, cursor: first.nextCursor! })).rejects.toThrow(/snapshot|cursor/i);
  });

  it('applies protocol filters before calculating totals', async () => {
    const repoPath = makeRepo();
    const tools = new AutoDocTools(snapshotBinding(repoPath), new I18nManager('en-US'));
    const page = await tools.handleListApiContracts({ repoPath, protocolFilter: 'SOAP', limit: 1 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('pages realtime events in the same snapshot without losing records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-event-pages-'));
    roots.push(root);
    writeFileSync(join(root, 'server.js'), Array.from({ length: 251 }, (_, i) => `socket.on('event-${i}', handler);`).join('\n'));
    const tools = new AutoDocTools(snapshotBinding(root), new I18nManager('en-US'));
    const names = new Set<string>();
    let page = await tools.handleListSocketContracts({ repoPath: root, limit: 100 });
    expect(page.total).toBe(251);
    expect(page.scanId).toBe('scan-1');
    while (true) {
      for (const item of page.items) names.add(item.eventName);
      if (!page.nextCursor) break;
      page = await tools.handleListSocketContracts({ repoPath: root, limit: 100, cursor: page.nextCursor });
    }
    expect(names.size).toBe(251);
  });

  it('marks only analysis-budget losses as truncated, independently of page continuation', async () => {
    const repoPath = makeRepo();
    const tools = new AutoDocTools(snapshotBinding(repoPath, undefined, undefined, 'partial', ['MAX_SOURCE_BYTES']), new I18nManager('en-US'));
    const page = await tools.handleListApiContracts({ repoPath, limit: 1 });
    expect(page.nextCursor).toBeTruthy();
    expect(page.truncated).toBe(true);
    expect(page.coverage.state).toBe('partial');
  });

  it('fails instead of reading source bytes changed since the pinned scan', async () => {
    const repoPath = makeRepo();
    const binding = snapshotBinding(repoPath);
    writeFileSync(join(repoPath, 'app.js'), "app.get('/changed-after-scan', handler);");
    const tools = new AutoDocTools(binding, new I18nManager('en-US'));
    await expect(tools.handleListApiContracts({ repoPath })).rejects.toThrow(/STALE/i);
  });

  it('rejects conflicting aliases for filters, roots, and requested scans', () => {
    expect(ListApiContractsSchema.safeParse({ repoPath: '/a', repository_path: '/b' }).success).toBe(false);
    expect(ListApiContractsSchema.safeParse({ protocolFilter: 'REST', protocol_filter: 'SOAP' }).success).toBe(false);
    expect(ListApiContractsSchema.safeParse({ scanId: 'scan-1', scan_id: 'scan-2' }).success).toBe(false);
    expect(ListSocketContractsSchema.safeParse({ directionFilter: 'ALL', direction_filter: 'SERVER_TO_CLIENT' }).success).toBe(false);
  });

  it('keeps all fields in a schema with more than twenty fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-schema-fields-'));
    roots.push(root);
    const fields = Array.from({ length: 21 }, (_, i) => `field${i} String`).join('\n');
    writeFileSync(join(root, 'schema.prisma'), `model Example {\n${fields}\n}`);
    const model = new SchemaAnalyzer(root).discoverModels(10).find((item) => item.modelName === 'Example');
    expect(model?.fields).toHaveLength(21);
  });

  it('returns every endpoint from the analyzer default catalog', () => {
    const repoPath = makeRepo();
    expect(new RestAnalyzer(repoPath).discoverEndpoints()).toHaveLength(201);
  });

  it('returns every realtime event from the analyzer default catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-events-'));
    roots.push(root);
    writeFileSync(join(root, 'server.js'), Array.from({ length: 251 }, (_, i) => `socket.on('event-${i}', handler);`).join('\n'));
    expect(new RealtimeAnalyzer(root).discoverSocketContracts()).toHaveLength(251);
  });

  it('returns every model from the analyzer default catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-models-'));
    roots.push(root);
    writeFileSync(join(root, 'schema.prisma'), Array.from({ length: 201 }, (_, i) => `model Model${i} {\n id String\n}`).join('\n'));
    expect(new SchemaAnalyzer(root).discoverModels()).toHaveLength(201);
  });

  it('exports every discovered endpoint into the generated reference', () => {
    const repoPath = makeRepo();
    const docs = new DiataxisGenerator(repoPath).synthesizeFullDocumentation();
    const reference = docs.find((doc) => doc.relativePath === 'reference/http-endpoints.md');
    expect(reference?.content).toContain('Total Endpoints Cataloged: **201**');
    expect(reference?.content).toContain('GET');
    expect(reference?.content).toContain('/item-200');
  });

  it('exports complete realtime and schema catalogs', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-doc-catalogs-'));
    roots.push(root);
    writeFileSync(join(root, 'server.js'), Array.from({ length: 251 }, (_, i) => `socket.on('event-${i}', handler);`).join('\n'));
    writeFileSync(join(root, 'schema.prisma'), Array.from({ length: 201 }, (_, i) => `model Model${i} {\n id String\n}`).join('\n'));

    const docs = new DiataxisGenerator(root).synthesizeFullDocumentation();
    const events = docs.find((doc) => doc.relativePath === 'reference/socket-events.md');
    const models = docs.find((doc) => doc.relativePath === 'reference/data-models.md');
    expect(events?.content).toContain('Total Realtime Events Cataloged: **251**');
    expect(events?.content).toContain('event-250');
    expect(models?.content).toContain('Total Root Models & Collections: **201**');
    expect(models?.content).toContain('Model200');
  });

  it('exports the complete catalog from one snapshot while paging its inventory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-snapshot-export-pages-'));
    roots.push(root);
    for (let i = 0; i < 501; i++) writeFileSync(join(root, `route-${i}.js`), `app.get('/snapshot-${i}', handler);`);
    const filePageCursors: Array<string | null> = [];
    const binding = snapshotBinding(root, undefined, undefined, 'complete', [], (collection, cursor) => {
      if (collection === 'files') filePageCursors.push(cursor);
    });
    const snapshot = await loadSnapshot(root, undefined, binding);
    const docs = new DiataxisGenerator(root, { snapshot }).synthesizeFullDocumentation();
    const reference = docs.find((doc) => doc.relativePath === 'reference/http-endpoints.md');
    expect(reference?.content).toContain('Total Endpoints Cataloged: **501**');
    expect(reference?.content).toContain('/snapshot-500');
    expect(docs.every((doc) => doc.scanId === snapshot.scanId)).toBe(true);
    expect(filePageCursors).toContain(null);
    expect(filePageCursors.some((cursor) => cursor !== null)).toBe(true);
  });

  it('refuses Diátaxis generation when snapshot evidence becomes stale', async () => {
    const root = makeRepo();
    const snapshot = await loadSnapshot(root, undefined, snapshotBinding(root));
    writeFileSync(join(root, 'app.js'), "app.get('/changed-after-snapshot', handler);");
    expect(() => new DiataxisGenerator(root, { snapshot }).synthesizeFullDocumentation()).toThrow(/STALE/i);
  });
});
