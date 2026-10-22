import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { DiataxisGenerator } from '../src/diataxis/generator.js';
import { DiagramRenderer } from '../src/diagrams/renderer.js';
import { loadNativeBinding } from '../src/binding.js';
import { loadSnapshot } from '../src/analysis/snapshot.js';

const roots: string[] = [];
let mermaid: typeof import('mermaid').default;
let dom: JSDOM;
beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    Element: dom.window.Element,
    SVGElement: dom.window.SVGElement,
  });
  mermaid = (await import('mermaid')).default;
});
afterAll(() => dom.window.close());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('generated diagram syntax', () => {
  it.each(['cli', 'library', 'api', 'mixed', 'static-site', 'unsupported'] as const)('exports the annotated number of %s active-generation diagrams and parses every Mermaid block', async (profile) => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-diagrams-'));
    roots.push(root);
    const fixture = resolve(`tests/fixtures/${profile}`);
    const expected = JSON.parse(readFileSync(join(fixture, 'expected-facts.json'), 'utf8'));
    cpSync(fixture, root, { recursive: true, filter: (source) => basename(source) !== 'expected-facts.json' });
    const binding = loadNativeBinding();
    const scan = binding.scanRepositoryNative!(root);
    const snapshot = await loadSnapshot(root, scan.scanId, binding);
    const docs = new DiataxisGenerator(root, { snapshot }).synthesizeFullDocumentation();
    const blocks = docs.flatMap((doc) => [...doc.content.matchAll(/```mermaid\s*([\s\S]*?)```/g)].map((match) => match[1].trim()));
    expect(expected.coverage.diagrams.state).toBe('complete');
    expect(blocks.length).toBe(expected.diagramCount);
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    for (const block of blocks) await mermaid.parse(block);
  });

  it('escapes quotes and special characters in generated C4 Mermaid', async () => {
    const diagram = DiagramRenderer.renderC4Mermaid({
      level: 2,
      title: 'Service',
      nodes: [{ id: 'module:"alpha" 1', label: 'API "v1" <module>', desc: 'owner & support' }],
      edges: [{ from: 'module:"alpha" 1', to: 'module:"alpha" 1', label: 'calls "handler" with data & <input>' }],
    });
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    await mermaid.parse(diagram);
    expect(diagram).not.toContain('module:"alpha" 1');
    expect(diagram).toContain('&quot;');
    expect(diagram).toContain('&amp;');
    expect(diagram).toContain('&lt;');
  });

  it('normalizes newline labels and parses generated Mermaid', async () => {
    const diagram = DiagramRenderer.renderC4Mermaid({ level: 2, title: 'service\nrelease' });
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    expect(diagram).toContain('service release');
    expect(diagram).not.toContain('\nrelease');
    await mermaid.parse(diagram);
  });

  it('rejects malformed Mermaid syntax', async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    await expect(mermaid.parse('graph TD\nA -->')).rejects.toThrow();
  });
});
