import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiataxisGenerator } from '../src/diataxis/generator.js';

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'autodoc-static-'));
  tempRoots.push(root);
  cpSync(resolve('tests/fixtures/static-site'), root, { recursive: true });
  return root;
}

describe('evidence-based generated docs', () => {
  it('does not assert backend prerequisites or project workflows for a static site', () => {
    const docs = new DiataxisGenerator(fixture()).synthesizeFullDocumentation();
    const text = docs.map((doc) => doc.content).join('\n');
    expect(text).not.toMatch(/Express|Socket\.io|Better Auth|WalletService/);
    expect(text).not.toMatch(/npm install|npm run build|cp \.env\.example/);
    expect(docs.some((doc) => doc.relativePath === 'how-to/add-new-module.md')).toBe(false);
  });

  it('does not claim build or test commands absent from package scripts', () => {
    const root = fixture();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { start: 'node app.js' } }));
    const docs = new DiataxisGenerator(root).synthesizeFullDocumentation();
    const text = docs.map((doc) => doc.content).join('\n');
    expect(text).toContain('npm run start');
    expect(text).not.toContain('npm run build');
    expect(text).not.toContain('npm test');
  });

  it('exports the complete endpoint catalog beyond the old 200 item cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'autodoc-catalog-'));
    tempRoots.push(root);
    const routes = Array.from({ length: 201 }, (_, index) => `app.get('/route-${index}', handler${index});`).join('\n');
    writeFileSync(join(root, 'routes.js'), routes);
    const reference = new DiataxisGenerator(root).synthesizeFullDocumentation()
      .find((doc) => doc.relativePath === 'reference/http-endpoints.md')!;
    expect(reference.content).toContain('Total Endpoints Cataloged: **201**');
    expect(reference.content).toContain('`/route-200`');
  });
});
