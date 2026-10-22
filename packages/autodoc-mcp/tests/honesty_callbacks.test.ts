import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HonestyAnalyzer } from '../src/analyzers/honesty/index.js';
import type { SnapshotContext } from '../src/analysis/snapshot.js';
import type { SnapshotPage } from '../src/analysis/contracts.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('honesty callback candidates', () => {
  it('reports evidence-backed zero-in-degree functions as candidates with partial coverage, not dead code', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-honesty-'));
    roots.push(root);
    const coverage = { state: 'complete' as const, examined: 1, excluded: 0, diagnostics: [] };
    const collections: Record<SnapshotPage['collection'], Array<Record<string, unknown>>> = {
      // No source files are needed to test the persisted fact/evidence heuristic.
      files: [],
      facts: [{ id: 'src/ui.js::onload', kind: 'function', evidenceIds: ['ev-onload'], attributes: { name: 'onload', path: 'src/ui.js' } }],
      evidence: [{ id: 'ev-onload', path: 'src/ui.js', contentSha256: 'a'.repeat(64), lineStart: 1, lineEnd: 1, extractor: 'ast', method: 'ast' }],
      relations: [],
    };
    const snapshot: SnapshotContext = {
      repositoryRoot: root, scanId: 'honesty-scan',
      metadata: { contractVersion: 2, schemaVersion: 5, scanId: 'honesty-scan', repositoryRoot: root, createdAt: '2026-10-22T10:00:00.000Z', extractorVersions: {}, coverage: { source: coverage }, latestAttempt: null, freshness: 'verified', totals: { facts: 1, evidence: 1, relations: 0, files: 1 } },
      readPage(collection, cursor = null) {
        const items = collections[collection].slice(cursor ? Number(cursor) : 0, (cursor ? Number(cursor) : 0) + 500);
        return { contractVersion: 2, schemaVersion: 5, scanId: 'honesty-scan', repositoryRoot: root, collection, items, total: collections[collection].length, nextCursor: null, coverage } as SnapshotPage;
      },
    };
    const report = new HonestyAnalyzer(root, snapshot).generateHonestyReport();
    expect(report.coverage).toBe('partial');
    expect(report.scanId).toBe('honesty-scan');
    expect(report.candidateCount).toBe(1);
    expect(report.orphanSymbols[0].reason).toMatch(/callbacks.*may explain/i);
  });

  it('does not use mutable legacy cache rows when no snapshot is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-honesty-legacy-'));
    roots.push(root);
    const report = new HonestyAnalyzer(root).generateHonestyReport();
    expect(report.coverage).toBe('not_scanned');
    expect(report.orphanSymbols).toEqual([]);
  });
});
