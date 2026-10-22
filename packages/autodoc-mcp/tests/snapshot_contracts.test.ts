import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot, SnapshotReadError } from '../src/analysis/snapshot.js';
import type { NativeBinding } from '../src/binding.js';
import {
  EvidenceSchema,
  parseSnapshotMetadata,
  parseSnapshotPage,
  SnapshotPageSchema,
} from '../src/analysis/contracts.js';

const metadata = {
  contractVersion: 2,
  schemaVersion: 5,
  scanId: 'scan-1',
  repositoryRoot: '/tmp/project',
  createdAt: '2026-10-22T10:00:00.000Z',
  extractorVersions: { treeSitter: '1' },
  coverage: { source: { state: 'partial', examined: 2, excluded: 0, diagnostics: [{ code: 'READ_FAILED', path: 'a.ts' }] } },
  latestAttempt: { scanId: 'scan-2', state: 'running' },
  freshness: 'unchecked',
  totals: { facts: 1, evidence: 1, relations: 0, files: 2 },
};

const page = {
  contractVersion: 2,
  schemaVersion: 5,
  scanId: 'scan-1',
  repositoryRoot: '/tmp/project',
  collection: 'facts',
  items: [{ id: 'fact-1', kind: 'function', evidenceIds: ['e1'], attributes: { name: 'run' } }],
  total: 1,
  nextCursor: null,
  coverage: metadata.coverage.source,
};

describe('versioned snapshot contracts', () => {
  it('accepts a complete metadata envelope with a running latest attempt', () => {
    expect(parseSnapshotMetadata(metadata).latestAttempt?.state).toBe('running');
    expect(() => parseSnapshotMetadata({ ...metadata, contractVersion: 1 })).toThrow();
  });

  it('requires source hashes for AST evidence and valid source ranges', () => {
    expect(EvidenceSchema.safeParse({ id: 'e1', path: 'a.ts', extractor: 'ts', method: 'ast' }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ id: 'e1', path: 'a.ts', extractor: 'callsite', method: 'tree_sitter_ast', contentSha256: 'a'.repeat(64), lineStart: 2, lineEnd: 2 }).success).toBe(true);
    expect(EvidenceSchema.safeParse({ id: 'e1', path: 'a.ts', extractor: 'ts', method: 'ast', contentSha256: 'a'.repeat(64), lineStart: 9, lineEnd: 3 }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ id: 'e1', path: 'logo.png', extractor: 'inventory', method: 'inventory', contentSha256: null, lineStart: null, lineEnd: null }).success).toBe(true);
  });

  it('rejects a page that belongs to a different scan than its pinned context', () => {
    expect(parseSnapshotPage(page, { scanId: 'scan-1', repositoryRoot: '/tmp/project', collection: 'facts' }).scanId).toBe('scan-1');
    expect(() => parseSnapshotPage({ ...page, scanId: 'scan-2' }, { scanId: 'scan-1', repositoryRoot: '/tmp/project', collection: 'facts' })).toThrow();
  });

  it('validates each fact item instead of accepting unknown values', () => {
    expect(SnapshotPageSchema.safeParse({ ...page, items: [{ nonsense: true }] }).success).toBe(false);
  });

  it('accepts an unresolved relation without a destination', () => {
    const relationPage = {
      ...page,
      collection: 'relations',
      items: [{ id: 'r1', fromId: 'symbol-1', kind: 'calls', resolution: 'unresolved', candidateIds: [], evidenceIds: ['e1'] }],
    };
    expect(SnapshotPageSchema.safeParse(relationPage).success).toBe(true);
  });

  it('rejects a legacy page contract version', () => {
    expect(SnapshotPageSchema.safeParse({ ...page, contractVersion: 1 }).success).toBe(false);
  });
});

describe('snapshot reader', () => {
  function root() {
    return mkdtempSync(join(tmpdir(), 'autodoc-snapshot-reader-'));
  }
  const validMetadata = (repositoryRoot: string, scanId = 'scan-1') => ({ ...metadata, repositoryRoot, scanId });
  const validPage = (repositoryRoot: string, scanId = 'scan-1', collection: 'files' | 'facts' = 'files') => ({
    ...page,
    repositoryRoot,
    scanId,
    collection,
    items: collection === 'files' ? [{ path: 'a.ts', category: 'source', support: 'ast', contentSha256: null, excludedReason: null, readError: null }] : page.items,
  });
  const mockBinding = (overrides: Partial<NativeBinding> = {}): NativeBinding => ({
    initLogger() {}, ping: () => ({ traceId: '', status: 'OK', version: '', rustcVersion: '', timestampMs: 0 }),
    triggerPanicTest: () => '', acquireExportLockNative: () => '', releaseExportLockNative() {},
    readRepositorySnapshotNative: () => JSON.stringify(validMetadata(currentRoot)),
    readSnapshotPageNative: (_repo, scanId, collection) => JSON.stringify(validPage(currentRoot, scanId, collection as 'files' | 'facts')),
    ...overrides,
  });
  let currentRoot = '';

  it('keeps all pages pinned to one scan even when a newer scan is published', async () => {
    currentRoot = root();
    try {
      const binding = mockBinding({
        readSnapshotPageNative: (_repo, scanId, collection) => JSON.stringify(validPage(currentRoot, scanId, collection as 'files' | 'facts')),
      });
      const context = await loadSnapshot(currentRoot, 'scan-1', binding);
      expect(context.readPage('files').scanId).toBe('scan-1');
      expect(context.readPage('files', 'cursor-from-g2').scanId).toBe('scan-1');
      expect(binding.readRepositorySnapshotNative).toBeDefined();
    } finally { rmSync(currentRoot, { recursive: true, force: true }); }
  });

  it('reports not scanned and rejects cursor or page identity divergence', async () => {
    currentRoot = root();
    try {
      await expect(loadSnapshot(currentRoot, undefined, mockBinding({ readRepositorySnapshotNative: () => { throw new Error('NOT_SCANNED: none'); } })))
        .rejects.toThrowError(SnapshotReadError);
      const context = await loadSnapshot(currentRoot, undefined, mockBinding({
        readSnapshotPageNative: (_repo, _scan, _collection, cursor) => {
          if (cursor) throw new Error('INVALID_CURSOR: mismatched');
          return JSON.stringify(validPage(currentRoot, 'scan-other'));
        },
      }));
      expect(() => context.readPage('files')).toThrowError(/does not match/);
      expect(() => context.readPage('files', 'invalid')).toThrowError(SnapshotReadError);
    } finally { rmSync(currentRoot, { recursive: true, force: true }); }
  });

  it('rejects invalid limits and unavailable pinned generations explicitly', async () => {
    currentRoot = root();
    try {
      const context = await loadSnapshot(currentRoot, undefined, mockBinding({
        readSnapshotPageNative: () => { throw new Error('SNAPSHOT_UNAVAILABLE: expired'); },
      }));
      expect(() => context.readPage('files', null, 501)).toThrowError(/INVALID_LIMIT/);
      expect(() => context.readPage('files')).toThrowError(SnapshotReadError);
    } finally { rmSync(currentRoot, { recursive: true, force: true }); }
  });
});
