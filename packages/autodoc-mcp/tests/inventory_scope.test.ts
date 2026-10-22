import { describe, expect, it, vi } from 'vitest';
import { readVerifiedSource, selectInventoryFiles, StaleSourceError } from '../src/analysis/source-reader.js';
import { ContainerInfraAnalyzer } from '../src/analyzers/containers.js';

describe('inventory scoped source reads', () => {
  const items = [
    { path: 'src/a.ts', category: 'source' as const, support: 'ast' as const, contentSha256: 'a'.repeat(64) },
    { path: 'assets/logo.png', category: 'asset' as const, support: 'metadata' as const, contentSha256: null },
    { path: 'ignored.ts', category: 'source' as const, support: 'ast' as const, contentSha256: 'b'.repeat(64), excludedReason: 'gitignore' },
    { path: 'denied.ts', category: 'source' as const, support: 'ast' as const, contentSha256: null, readError: 'permission denied' },
  ];
  const context = {
    scanId: 'scan-1',
    repositoryRoot: '/repo',
    readPage: vi.fn((_collection: 'files', cursor: string | null, _limit: number) => ({
      contractVersion: 2 as const, schemaVersion: 5 as const, scanId: 'scan-1', repositoryRoot: '/repo',
      collection: 'files' as const, nextCursor: cursor === null ? 'page-2' : null, total: items.length,
      coverage: { state: 'complete' as const, examined: items.length, excluded: 1, diagnostics: [] },
      items: cursor === null ? items.slice(0, 2) : items.slice(2),
    })),
  };

  it('selects only included inventory paths of requested categories', () => {
    expect(selectInventoryFiles(context, ['source']).map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('reads only bytes pinned by the inventory hash', () => {
    const nativeRead = vi.fn(() => Buffer.from('source'));
    expect(readVerifiedSource(context, 'src/a.ts', nativeRead).toString()).toBe('source');
    expect(nativeRead).toHaveBeenCalledWith('/repo', 'src/a.ts', 'a'.repeat(64));
  });

  it('rejects paths absent from the scan inventory and metadata-only assets', () => {
    expect(() => readVerifiedSource(context, 'ignored.ts')).toThrow(/excluded/);
    expect(() => readVerifiedSource(context, 'assets/logo.png')).toThrow(/no verified source hash/);
    expect(() => readVerifiedSource(context, '../outside.ts')).toThrow(/not in scan inventory/);
    const nativeRead = vi.fn();
    expect(() => readVerifiedSource(context, 'assets/logo.png', nativeRead)).toThrow(/no verified source hash/);
    expect(nativeRead).not.toHaveBeenCalled();
  });

  it('translates native content mismatch into a stale source error', () => {
    const nativeRead = vi.fn(() => { throw new Error('STALE_SOURCE expected=old actual=new'); });
    expect(() => readVerifiedSource(context, 'src/a.ts', nativeRead)).toThrow(StaleSourceError);
  });

  it('does not build a container map from compose bytes changed after the scan', () => {
    const inventory = [{ path: 'compose.yaml', category: 'infra' as const, support: 'heuristic' as const, contentSha256: 'c'.repeat(64) }];
    const context = {
      scanId: 'scan-compose', repositoryRoot: '/repo', metadata: {} as never,
      readPage: vi.fn(() => ({
        contractVersion: 2 as const, schemaVersion: 5 as const, scanId: 'scan-compose', repositoryRoot: '/repo',
        collection: 'files' as const, nextCursor: null, total: 1,
        coverage: { state: 'complete' as const, examined: 1, excluded: 0, diagnostics: [] }, items: inventory,
      })),
    };
    const nativeRead = vi.fn(() => { throw new Error('STALE_SOURCE expected=' + 'c'.repeat(64) + ' actual=' + 'd'.repeat(64)); });
    expect(() => new ContainerInfraAnalyzer('/repo', context, nativeRead).analyze()).toThrow(StaleSourceError);
    expect(nativeRead).toHaveBeenCalledWith('/repo', 'compose.yaml', 'c'.repeat(64));
  });
});
