import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RestAnalyzer } from '../src/analyzers/rest/index.js';
import { WorkspaceAnalyzer } from '../src/analyzers/workspace.js';
import { loadNativeBinding } from '../src/binding.js';
import { AutoDocTools } from '../src/tools/handlers.js';
import { I18nManager } from '../src/i18n/index.js';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function loadFixture(name: string): { root: string; expected: any } {
  const root = mkdtempSync(join(tmpdir(), `autodoc-eval-${name}-`));
  roots.push(root);
  const fixture = resolve(`tests/fixtures/${name}`);
  const expected = JSON.parse(readFileSync(join(fixture, 'expected-facts.json'), 'utf8'));
  cpSync(fixture, root, { recursive: true, filter: (source) => basename(source) !== 'expected-facts.json' });
  return { root, expected };
}

describe('portable product accuracy fixtures', () => {
  it.each(['api', 'mixed'] as const)('measures declared REST facts against the independent %s fixture', async (profile) => {
    const { root, expected } = loadFixture(profile);
    expect(expected.coverage.endpoints.state).toBe('partial');
    expect(expected.coverage.endpoints.diagnostic).toBeTruthy();
    const actual = new RestAnalyzer(root).discoverEndpoints().map((route) =>
      `${route.method} ${route.endpoint} ${route.sourceFile} ${route.confidence}`);
    const wanted = expected.endpoints
      .map((fact: any) => `${fact.method} ${fact.path} ${fact.source} regex`);
    const actualSet = new Set(actual);
    const expectedSet = new Set(wanted);
    const truePositives = [...expectedSet].filter((fact) => actualSet.has(fact)).length;
    const precision = actualSet.size ? [...actualSet].filter((fact) => expectedSet.has(fact)).length / actualSet.size : 1;
    const recall = expectedSet.size ? truePositives / expectedSet.size : 1;
    expect({ precision, recall }).toEqual({ precision: 1, recall: 1 });

    const binding = loadNativeBinding();
    binding.scanRepositoryNative!(root);
    const tools = new AutoDocTools(binding, new I18nManager('en-US'));
    const response = await tools.handleListApiContracts({ repoPath: root, protocolFilter: 'ALL' });
    expect(response.scanId).toBeTruthy();
    expect(response.coverage.state).toBe('partial');
    expect(response.coverage.diagnostics.map((diagnostic: any) => diagnostic.code)).toContain('API_ROUTE_HEURISTIC_NO_EVIDENCE');
    expect(response.contracts.map((route: any) => `${route.method} ${route.endpoint} ${route.sourceFile} ${route.confidence}`).sort())
      .toEqual(wanted.sort());
  });

  it('reports unknown command capabilities instead of claiming absent scripts exist', () => {
    const { root, expected } = loadFixture('cli');
    const workspace = new WorkspaceAnalyzer(root).analyze();
    expect(expected.capabilities).toContain('python-source');
    expect(workspace.commands.build).toBeNull();
    expect(workspace.commands.test).toBeNull();
  });

  it.each(['cli', 'library', 'api', 'mixed', 'static-site', 'unsupported'] as const)('compares active-generation output with independent %s annotations', (profile) => {
    const { root, expected } = loadFixture(profile);
    const scan = loadNativeBinding().scanRepositoryNative!(root);
    const metadata = JSON.parse(loadNativeBinding().readRepositorySnapshotNative!(root));
    expect(scan.analysisState).toBe(expected.coverage.scan.state);
    expect(scan.scanId).toBeTruthy();
    expect(scan.activeScanId).toBe(scan.scanId);
    for (const collection of ['facts', 'schema', 'evidence', 'relations'] as const) {
      const expectedCoverage = expected.coverage[collection];
      const actualCoverage = metadata.coverage[collection];
      expect(actualCoverage.state, `${collection} coverage state`).toBe(expectedCoverage.state);
      expect(actualCoverage.diagnostics.map((diagnostic: any) => diagnostic.code)).toContain(expectedCoverage.diagnosticCode);
    }
    const db = new DatabaseSync(join(root, '.autodoc/cache.db'), { readOnly: true });
    const actualSymbols = db.prepare(`SELECT s.symbol_id AS id, s.kind, s.name, f.path,
        s.line_start AS lineStart, s.line_end AS lineEnd, s.visibility, s.signature
      FROM scan_state state
      JOIN generation_symbols s ON s.scan_id = state.active_scan_id
      JOIN generation_files f ON f.scan_id = s.scan_id AND f.file_id = s.file_id
      WHERE state.singleton = 1
      ORDER BY f.path, s.name`).all() as Array<Record<string, unknown>>;
    const actualInventory = db.prepare(`SELECT path, category, support, content_sha256 AS contentSha256
      FROM inventory_files WHERE scan_id = ?1 ORDER BY path`).all(scan.scanId) as Array<Record<string, unknown>>;
    const actualFacts = db.prepare(`SELECT fact_id AS id, kind, attributes_json AS attributes, evidence_ids_json AS evidenceIds
      FROM facts WHERE scan_id = ?1 ORDER BY fact_id`).all(scan.scanId).map((row: any) => ({
        id: row.id, kind: row.kind, attributes: JSON.parse(row.attributes), evidenceIds: JSON.parse(row.evidenceIds),
      }));
    const actualEvidence = db.prepare(`SELECT evidence_id AS id, path, content_sha256 AS contentSha256,
        line_start AS lineStart, line_end AS lineEnd, extractor, method
      FROM evidence WHERE scan_id = ?1 ORDER BY evidence_id`).all(scan.scanId);
    const actualRelations = db.prepare(`SELECT relation_id AS id, from_id AS fromId, to_id AS toId, kind,
        resolution, candidate_ids_json AS candidateIds, evidence_ids_json AS evidenceIds
      FROM relations WHERE scan_id = ?1 ORDER BY relation_id`).all(scan.scanId).map((row: any) => ({
        id: row.id, fromId: row.fromId, toId: row.toId, kind: row.kind, resolution: row.resolution,
        candidateIds: JSON.parse(row.candidateIds), evidenceIds: JSON.parse(row.evidenceIds),
      }));
    const run = db.prepare('SELECT state, diagnostics_json AS diagnostics FROM scan_runs WHERE scan_id = ?1').get(scan.scanId) as any;
    const totals = {
      files: actualInventory.length,
      facts: actualFacts.length,
      evidence: actualEvidence.length,
      relations: actualRelations.length,
    };
    db.close();
    const scanDiagnostics = JSON.parse(run.diagnostics).map((diagnostic: any) => ({ code: diagnostic.code, path: diagnostic.path ?? null }));
    expect(run.state).toBe(expected.coverage.scan.state);
    expect(scanDiagnostics).toEqual(expected.coverage.scan.diagnostics);
    expect(actualSymbols).toEqual(expected.symbols);
    expect(actualInventory).toEqual(expected.inventory);
    expect(actualFacts).toEqual(expected.facts);
    expect(actualEvidence).toEqual(expected.evidence);
    expect(actualRelations).toEqual(expected.relations);
    expect(totals).toEqual({
      files: expected.inventory.length,
      facts: expected.facts.length,
      evidence: expected.evidence.length,
      relations: expected.relations.length,
    });

    const actualSchemas = actualFacts.filter((fact: any) => fact.kind === 'schema');
    expect(actualSchemas).toEqual(expected.schemas);
    const collections = { facts: actualFacts, schema: actualSchemas, evidence: actualEvidence, relations: actualRelations };
    for (const collection of ['facts', 'schema', 'evidence', 'relations'] as const) {
      const assessment = expected.coverage[collection];
      if (assessment.state === 'unsupported' || assessment.state === 'partial') {
        expect(assessment.diagnostic, `${profile} ${collection} assessment must explain its gap`).toBeTruthy();
        expect(metadata.coverage[collection].diagnostics.map((diagnostic: any) => diagnostic.code)).toContain(assessment.diagnosticCode);
      }
      if (assessment.state === 'unsupported') {
        expect(collections[collection].length).toBe(0);
      }
    }
    for (const unsupported of expected.unsupportedRelations ?? []) {
      expect(unsupported.diagnostic).toBeTruthy();
      expect(actualRelations.some((relation: any) => relation.kind === unsupported.kind)).toBe(false);
    }
  });

  it('keeps unsupported fixtures explicitly unclassified', () => {
    const { root, expected } = loadFixture('unsupported');
    expect(expected.profile).toBe('unsupported');
    expect(expected.coverage.symbols.state).toBe('unsupported');
    expect(new RestAnalyzer(root).discoverEndpoints()).toEqual([]);
  });

  it('keeps G1 immutable and symbol IDs stable while a complete G2 removes/adds files', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-generation-eval-'));
    roots.push(root);
    const source = join(root, 'entry.ts');
    const removed = join(root, 'removed.ts');
    const binding = loadNativeBinding();
    writeFileSync(source, 'function helper() { return 1; }\nexport function stable() { return helper(); }\n');
    writeFileSync(removed, 'export function gone() { return 0; }\n');

    const first = binding.scanRepositoryNative!(root);
    expect(first.analysisState).toBe('complete');
    let db = new DatabaseSync(join(root, '.autodoc/cache.db'), { readOnly: false });
    const readSymbols = (scanId: string) => db.prepare(`SELECT s.symbol_id AS id, s.name, f.path
      FROM generation_symbols s JOIN generation_files f USING (scan_id, file_id)
      WHERE s.scan_id = ?1 ORDER BY f.path, s.name`).all(scanId);
    const readProjections = (scanId: string) => ({
      inventory: db.prepare('SELECT path,content_sha256 AS contentSha256 FROM inventory_files WHERE scan_id=?1 ORDER BY path').all(scanId),
      facts: db.prepare('SELECT fact_id AS id,kind,attributes_json AS attributes,evidence_ids_json AS evidenceIds FROM facts WHERE scan_id=?1 ORDER BY fact_id').all(scanId),
      evidence: db.prepare('SELECT evidence_id AS id,path,content_sha256 AS contentSha256,line_start AS lineStart,line_end AS lineEnd,extractor,method FROM evidence WHERE scan_id=?1 ORDER BY evidence_id').all(scanId),
      relations: db.prepare('SELECT relation_id AS id,from_id AS fromId,to_id AS toId,kind,resolution,candidate_ids_json AS candidateIds,evidence_ids_json AS evidenceIds FROM relations WHERE scan_id=?1 ORDER BY relation_id').all(scanId),
    });
    const generationOneBefore = readSymbols(first.scanId!);
    const projectionsOneBefore = readProjections(first.scanId!);
    db.close();
    rmSync(removed);
    writeFileSync(join(root, 'new.ts'), 'export function added() { return 3; }\n');

    const second = binding.scanRepositoryNative!(root);
    db = new DatabaseSync(join(root, '.autodoc/cache.db'), { readOnly: true });
    expect(second.analysisState).toBe('complete');
    expect(second.activeScanId).toBe(second.scanId);
    expect(second.scanId).not.toBe(first.scanId);
    expect(readSymbols(first.scanId!)).toEqual(generationOneBefore);
    expect(readSymbols(second.scanId!)).toEqual([
      { id: 'entry.ts::helper', name: 'helper', path: 'entry.ts' },
      { id: 'entry.ts::stable', name: 'stable', path: 'entry.ts' },
      { id: 'new.ts::added', name: 'added', path: 'new.ts' },
    ]);
    const projectionsOneAfter = readProjections(first.scanId!);
    const projectionsTwo = readProjections(second.scanId!);
    expect(projectionsOneAfter).toEqual(projectionsOneBefore);
    expect(projectionsTwo.facts).toEqual(projectionsOneBefore.facts);
    expect(projectionsTwo.evidence).toEqual(projectionsOneBefore.evidence);
    expect(projectionsTwo.relations).toEqual(projectionsOneBefore.relations);
    expect(projectionsTwo.inventory.map((file: any) => file.path)).toContain('new.ts');
    expect(projectionsTwo.inventory.map((file: any) => file.path)).not.toContain('removed.ts');
    expect(projectionsTwo.inventory.filter((file: any) => file.path === 'entry.ts')).toEqual(projectionsOneBefore.inventory.filter((file: any) => file.path === 'entry.ts'));
    expect(readSymbols(second.scanId!).some((symbol: any) => symbol.name === 'gone')).toBe(false);
    expect(readSymbols(first.scanId!).some((symbol: any) => symbol.name === 'gone')).toBe(true);
    db.close();
  });
});
