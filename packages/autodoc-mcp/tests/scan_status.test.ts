import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoDocTools, getLastScannedRepoPath, setLastScannedRepoPath } from '../src/tools/handlers.js';
import { I18nManager } from '../src/i18n/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(join(tmpdir(), 'autodoc-scan-status-')); roots.push(value); return value; };
const tools = (binding: unknown) => new AutoDocTools(binding as never, new I18nManager('en-US'));

describe('scan status', () => {
  it('forwards bounded scan resource options to the native scanner', async () => {
    const repoPath = root();
    let received: unknown;
    const tool = tools({ scanRepositoryNative: (_path: string, options: unknown) => {
      received = options;
      return { totalFiles: 0, totalLoc: 0, totalSymbols: 0, totalEdges: 0, languages: [], cachePath: '', analysisState: 'complete', diagnostics: [] };
    } });
    await tool.handleScanRepository({ repoPath, maxSourceBytes: 1024, workers: 2, queueCapacity: 8, batchSize: 128 });
    expect(received).toEqual({ maxSourceBytes: 1024, workers: 2, queueCapacity: 8, batchSize: 128 });
  });

  it('reports a valid empty scan as complete', async () => {
    const result = await tools({ scanRepositoryNative: () => ({ scanId: 'scan-current', activeScanId: 'scan-current', totalFiles: 0, totalLoc: 0, totalSymbols: 0, totalEdges: 0, languages: [], cachePath: '', analysisState: 'complete', diagnostics: [] }) }).handleScanRepository({ repoPath: root() });
    expect(result.status).toBe('SUCCESS');
    expect(result.analysisState).toBe('complete');
    expect(result.scanId).toBe('scan-current');
    expect(result.activeScanId).toBe('scan-current');
    expect(result.coverageState).toBe('complete');
  });

  it('reports partial semantic coverage even when inventory publication succeeds', async () => {
    const result = await tools({ scanRepositoryNative: () => ({ scanId: 'scan-current', activeScanId: 'scan-current', totalFiles: 1, totalLoc: 1, totalSymbols: 0, totalEdges: 0, languages: ['cs'], cachePath: '', analysisState: 'complete', coverageState: 'partial', diagnostics: [{ stage: 'parse', code: 'AST_UNSUPPORTED', path: 'Runner.cs', message: 'No AST parser is available.' }] }) }).handleScanRepository({ repoPath: root() });
    expect(result.status).toBe('PARTIAL');
    expect(result.analysisState).toBe('complete');
    expect(result.coverageState).toBe('partial');
    expect(result.activeScanId).toBe('scan-current');
  });

  it('does not convert a native failure into a successful empty scan', async () => {
    const previous = root();
    const failed = root();
    setLastScannedRepoPath(previous);
    const result = await tools({ scanRepositoryNative: () => { throw new Error('injected failure'); } }).handleScanRepository({ repoPath: failed });
    expect(result.status).toBe('FAILED');
    expect(result.analysisState).toBe('failed');
    expect(result.diagnostics[0]).toMatchObject({ stage: 'scan', code: 'NATIVE_SCAN_FAILED' });
    expect(getLastScannedRepoPath()).toBe(previous);
  });

  it('preserves partial scan diagnostics', async () => {
    const result = await tools({ scanRepositoryNative: () => ({ totalFiles: 1, totalLoc: 1, totalSymbols: 0, totalEdges: 0, languages: ['ts'], cachePath: '', analysisState: 'partial', diagnostics: [{ stage: 'read', code: 'FILE_READ_FAILED', path: 'x.ts', message: 'unreadable' }] }) }).handleScanRepository({ repoPath: root() });
    expect(result.status).toBe('PARTIAL');
    expect(result.diagnostics).toHaveLength(1);
  });

  it('does not switch the implicit repository to an incomplete attempt with an older active snapshot', async () => {
    const previous = root();
    const attempted = root();
    setLastScannedRepoPath(previous);
    const result = await tools({ scanRepositoryNative: () => ({ scanId: 'scan-new', activeScanId: 'scan-old', totalFiles: 1, candidateFiles: 1, filesWithErrors: 1, totalLoc: 1, totalSymbols: 0, totalEdges: 0, languages: ['ts'], cachePath: '', analysisState: 'partial', diagnostics: [{ stage: 'parse', code: 'SYNTAX_RECOVERY', path: 'bad.ts', message: 'partial' }] }) }).handleScanRepository({ repoPath: attempted });
    expect(result.status).toBe('PARTIAL');
    expect(getLastScannedRepoPath()).toBe(previous);
  });
});
