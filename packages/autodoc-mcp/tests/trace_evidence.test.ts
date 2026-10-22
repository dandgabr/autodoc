import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoDocTools } from '../src/tools/handlers.js';
import { I18nManager } from '../src/i18n/index.js';
import { TraceDataFlowSchema } from '../src/tools/handlers.js';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('trace evidence', () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it('does not invent paths or sinks when the repository has not been scanned', async () => {
    root = mkdtempSync(join(tmpdir(), 'autodoc-trace-'));
    const tools = new AutoDocTools({} as never, new I18nManager('en-US'));
    const result = await tools.handleTraceDataFlow({ repository_path: root, entrypoint_symbol: 'missing', max_depth: 2 });
    expect(result.path).toEqual([]);
    expect(result.sink).toBeNull();
    expect(result.taintStatus).toBe('UNKNOWN');
    expect(result.status).toBe('NOT_SCANNED');
    expect(result.maxDepth).toBe(2);
  });

  it('does not fabricate a contract for an unknown symbol', async () => {
    root = mkdtempSync(join(tmpdir(), 'autodoc-contract-'));
    const tools = new AutoDocTools({} as never, new I18nManager('en-US'));
    const result = await tools.handleGetSymbolContract({ repository_path: root, symbolName: 'missing' });
    expect(result.status).toBe('NOT_SCANNED');
    expect(result.deterministicContract.raw).toBeNull();
    expect(result.lineStart).toBeNull();
  });

  it('does not certify legacy cached rows that have no active scan ID', async () => {
    root = mkdtempSync(join(tmpdir(), 'autodoc-legacy-cache-'));
    mkdirSync(join(root, '.autodoc'));
    const db = new DatabaseSync(join(root, '.autodoc/cache.db'));
    db.exec(`CREATE TABLE files(file_id INTEGER PRIMARY KEY, path TEXT);
      CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY, file_id INTEGER, fqsn TEXT, name TEXT,
        signature_clean TEXT, cyclomatic_complexity INTEGER, line_start INTEGER, line_end INTEGER);
      INSERT INTO files VALUES (1, 'legacy.ts');
      INSERT INTO symbols VALUES (1, 1, 'legacy.ts::present', 'present', 'function present()', 1, 1, 1);`);
    db.close();

    const tools = new AutoDocTools({} as never, new I18nManager('en-US'));
    const symbol = await tools.handleGetSymbolContract({ repository_path: root, symbolName: 'present' });
    const trace = await tools.handleTraceDataFlow({ repository_path: root, entrypoint_symbol: 'present' });
    const diagram = await tools.handleGetC4Diagram({ repository_path: root, level: 3, llm_enrich: true });
    expect(symbol.status).toBe('NOT_SCANNED');
    expect(symbol.deterministicContract.raw).toBeNull();
    expect(trace.status).toBe('NOT_SCANNED');
    expect(diagram.status).toBe('NOT_SCANNED');
    expect(diagram.diagram).toBeNull();
  });

  it('normalizes max-depth aliases before defaults and rejects conflicts', () => {
    expect(TraceDataFlowSchema.parse({ max_depth: 2 }).maxDepth).toBe(2);
    expect(TraceDataFlowSchema.parse({ maxDepth: 2, max_depth: 2 }).maxDepth).toBe(2);
    expect(() => TraceDataFlowSchema.parse({ maxDepth: 2, max_depth: 3 })).toThrow();
  });
});
