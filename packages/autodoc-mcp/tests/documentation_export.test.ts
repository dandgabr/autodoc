import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DocumentationExporter } from '../src/diataxis/exporter.js';
import type { GeneratedDocFile } from '../src/diataxis/generator.js';
import { loadNativeBinding } from '../src/binding.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const target = () => { const root = mkdtempSync(join(tmpdir(), 'autodoc-export-')); roots.push(root); return root; };
const doc = (relativePath: string, content: string): GeneratedDocFile => ({ relativePath, content, title: 'Fixture', quadrant: 'reference' });
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const testKey = Buffer.from('01234567890123456789012345678901');
const sign = (content: string) => createHmac('sha256', testKey).update(content).digest('hex');
const originalStateRoot = process.env.XDG_STATE_HOME;
const testStateRoot = mkdtempSync(join(tmpdir(), 'autodoc-export-state-'));
mkdirSync(join(testStateRoot, 'autodoc'), { mode: 0o700 });
writeFileSync(join(testStateRoot, 'autodoc', 'export.key'), testKey, { mode: 0o600 });
process.env.XDG_STATE_HOME = testStateRoot;
const makeExporter = () => new DocumentationExporter();
afterAll(() => {
  if (originalStateRoot === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateRoot;
  rmSync(testStateRoot, { recursive: true, force: true });
});

describe('documentation export ownership', () => {
  it('preserves a manual file at an output path', () => {
    const root = target();
    writeFileSync(join(root, 'guide.md'), 'manual');
    expect(() => makeExporter().export(root, [doc('guide.md', 'generated')])).toThrow(/conflict/i);
    expect(readFileSync(join(root, 'guide.md'), 'utf8')).toBe('manual');
  });

  it('reconciles only unchanged files listed in the prior manifest', () => {
    const root = target();
    const exporter = makeExporter();
    exporter.export(root, [doc('old.md', 'old'), doc('keep.md', 'keep')], 'scan-1');
    exporter.export(root, [doc('keep.md', 'updated')], 'scan-2');
    expect(() => readFileSync(join(root, 'old.md'))).toThrow();
    expect(readFileSync(join(root, 'keep.md'), 'utf8')).toBe('updated');
  });

  it('preserves generated files edited by the user', () => {
    const root = target();
    const exporter = makeExporter();
    exporter.export(root, [doc('guide.md', 'generated')]);
    writeFileSync(join(root, 'guide.md'), 'user edit');
    expect(() => exporter.export(root, [doc('guide.md', 'new output')])).toThrow(/conflict/i);
    expect(readFileSync(join(root, 'guide.md'), 'utf8')).toBe('user edit');
  });

  it('recovers an interrupted replacement and keeps a user edit made after interruption', () => {
    const root = target();
    const previousManifest = JSON.stringify({ schemaVersion: 1, scanId: 'scan-1', files: [{ path: 'guide.md', sha256: hash('old') }] }, null, 2) + '\n';
    const interruptedManifest = JSON.stringify({ schemaVersion: 1, scanId: 'scan-2', files: [{ path: 'guide.md', sha256: hash('new') }] }, null, 2) + '\n';
    writeFileSync(join(root, '.autodoc-manifest.json'), interruptedManifest);
    writeFileSync(join(root, 'guide.md'), 'user edit during interrupted export');

    const transactionId = '00000000-0000-4000-8000-000000000001';
    const transaction = join(root, `.autodoc-stage-${transactionId}`);
    mkdirSync(join(transaction, 'backup'), { recursive: true });
    const owner = { schemaVersion: 1, transactionId, root };
    writeFileSync(join(transaction, 'owner.json'), JSON.stringify({ ...owner, mac: sign(JSON.stringify(owner)) }));
    writeFileSync(join(transaction, 'backup', 'guide.md'), 'old');
    writeFileSync(join(transaction, 'backup', '.autodoc-manifest.json'), previousManifest);
    const journal = {
      schemaVersion: 1,
      transactionId,
      phase: 'committing',
      operations: [
        { path: 'guide.md', hadOriginal: true, originalHash: hash('old'), newHash: hash('new') },
        { path: '.autodoc-manifest.json', hadOriginal: true, originalHash: hash(previousManifest), newHash: hash(JSON.stringify({ schemaVersion: 1, scanId: 'scan-2', files: [{ path: 'guide.md', sha256: hash('new') }] }, null, 2) + '\n') },
      ],
    };
    writeFileSync(join(transaction, 'journal.json'), JSON.stringify({ ...journal, mac: sign(JSON.stringify(journal)) }));

    expect(() => makeExporter().export(root, [doc('guide.md', 'next')], 'scan-3')).toThrow(/conflict/i);
    expect(readFileSync(join(root, 'guide.md'), 'utf8')).toBe('user edit during interrupted export');
    expect(readFileSync(join(root, '.autodoc-manifest.json'), 'utf8')).toBe(interruptedManifest);
    expect(() => readFileSync(join(transaction, 'journal.json'))).toThrow();
  });

  it('rejects an export while another process holds the destination lock', () => {
    const root = target();
    const native = loadNativeBinding();
    expect(native.acquireExportLockNative).toBeTypeOf('function');
    const token = native.acquireExportLockNative!(root);
    expect(() => makeExporter().export(root, [doc('guide.md', 'generated')])).toThrow(/locked/i);
    native.releaseExportLockNative!(token);
    expect(() => readFileSync(join(root, 'guide.md'))).toThrow();
  });

  it('locks the pinned directory identity while an ancestor is swapped during native acquisition', () => {
    if (process.platform !== 'linux') return;
    const base = target();
    const parent = join(base, 'parent');
    const heldParent = join(base, 'parent.held');
    const outsideParent = join(base, 'outside-parent');
    const root = join(parent, 'destination');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(outsideParent, 'destination'), { recursive: true });
    const native = loadNativeBinding();
    const wrapped = {
      ...native,
      acquireExportLockNative(directoryPath: string) {
        expect(directoryPath).toMatch(/^\/proc\/self\/fd\/\d+$/);
        renameSync(parent, heldParent);
        symlinkSync(outsideParent, parent);
        let token: string;
        try {
          token = native.acquireExportLockNative!(directoryPath);
        } finally {
          rmSync(parent);
          renameSync(heldParent, parent);
        }
        expect(() => native.acquireExportLockNative!(root)).toThrow(/locked/i);
        return token;
      },
    };
    expect(new DocumentationExporter(wrapped).export(root, [doc('guide.md', 'pinned')])).toEqual({ totalFiles: 1, writtenFiles: ['guide.md'] });
    expect(readFileSync(join(root, 'guide.md'), 'utf8')).toBe('pinned');
    expect(() => readFileSync(join(outsideParent, 'destination', 'guide.md'))).toThrow();
  });

  it('rejects an export while a separate live process holds the destination lock', async () => {
    const root = target();
    const lockPath = root;
    const nativePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/autodoc-core/autodoc-core.linux-x64-gnu.node');
    const child = spawn(process.execPath, ['-e', "require(process.argv[2]).acquireExportLockNative(process.argv[1]); console.log('LOCK_HELD'); setInterval(() => {}, 1000)", lockPath, nativePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('LOCK_HELD') && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    expect(stdout).toContain('LOCK_HELD');
    expect(() => makeExporter().export(root, [doc('blocked.md', 'blocked')])).toThrow(/locked/i);
    child.kill('SIGTERM');
    const [exitCode, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(signal).toBe('SIGTERM');
    expect(exitCode).toBeNull();
    expect(makeExporter().export(root, [doc('after.md', 'after')])).toEqual({ totalFiles: 1, writtenFiles: ['after.md'] });
  });

  it('reuses the destination lock after a completed export', () => {
    const root = target();
    expect(makeExporter().export(root, [doc('first.md', 'first')])).toEqual({ totalFiles: 1, writtenFiles: ['first.md'] });
    expect(makeExporter().export(root, [doc('guide.md', 'generated')])).toEqual({ totalFiles: 1, writtenFiles: ['guide.md'] });
    expect(readFileSync(join(root, 'guide.md'), 'utf8')).toBe('generated');
  });

  it('releases a destination lock automatically after the owning process exits', () => {
    const root = target();
    const native = loadNativeBinding();
    expect(native.acquireExportLockNative).toBeTypeOf('function');
    const lockPath = root;
    const nativePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/autodoc-core/autodoc-core.linux-x64-gnu.node');
    const child = spawnSync(process.execPath, ['-e', "require(process.argv[2]).acquireExportLockNative(process.argv[1])", lockPath, nativePath], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    const token = native.acquireExportLockNative!(root);
    native.releaseExportLockNative!(token);
    expect(makeExporter().export(root, [doc('guide.md', 'generated')])).toEqual({ totalFiles: 1, writtenFiles: ['guide.md'] });
    expect(readdirSync(testStateRoot).length).toBeGreaterThan(0);
  });

  it('recovers an export journal after the owner dies mid-commit and preserves a later manual edit', async () => {
    const root = target();
    const first = join(root, 'generated', '00000.md');
    const exporterPath = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/diataxis/exporter.js');
    const nativePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/autodoc-core/autodoc-core.linux-x64-gnu.node');
    const script = `
      import { pathToFileURL } from 'node:url';
      import { createRequire } from 'node:module';
      const { DocumentationExporter } = await import(pathToFileURL(process.argv[1]).href);
      const native = createRequire(import.meta.url)(process.argv[3]);
      const docs = Array.from({ length: 5000 }, (_, index) => ({ relativePath: 'generated/' + String(index).padStart(5, '0') + '.md', content: 'generated', title: 'Fixture', quadrant: 'reference' }));
      new DocumentationExporter(native).export(process.argv[2], docs, 'crash-scan');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, exporterPath, root, nativePath], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let childError = '';
    child.stderr?.on('data', (chunk) => { childError += String(chunk); });
    const deadline = Date.now() + 10_000;
    while (!existsSync(first) && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    expect(existsSync(first), childError).toBe(true);
    expect(readdirSync(root).some((name) => name.startsWith('.autodoc-stage-'))).toBe(true);
    child.kill('SIGKILL');
    const [exitCode, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(signal).toBe('SIGKILL');
    expect(exitCode).toBeNull();

    writeFileSync(first, 'manual edit after interrupted export');
    expect(makeExporter().export(root, [doc('final.md', 'complete')], 'next-scan')).toEqual({ totalFiles: 1, writtenFiles: ['final.md'] });
    expect(readFileSync(first, 'utf8')).toBe('manual edit after interrupted export');
    expect(readFileSync(join(root, 'final.md'), 'utf8')).toBe('complete');
    expect(readdirSync(root).some((name) => name.startsWith('.autodoc-stage-'))).toBe(false);
  });

  it('makes native lock release idempotent and rejects unknown tokens', () => {
    const root = target();
    const native = loadNativeBinding();
    const token = native.acquireExportLockNative!(root);
    expect(() => native.releaseExportLockNative!(token)).not.toThrow();
    expect(() => native.releaseExportLockNative!(token)).not.toThrow();
    expect(() => native.releaseExportLockNative!('unknown-token')).toThrow(/unknown/i);
  });

  it('fails closed on a corrupted lock database and preserves its bytes', () => {
    const root = target();
    const native = loadNativeBinding();
    const identity = statSync(root);
    const lockPath = join(testStateRoot, 'autodoc', 'export-locks', `${identity.dev.toString(16)}-${identity.ino.toString(16)}.sqlite`);
    const token = native.acquireExportLockNative!(root);
    native.releaseExportLockNative!(token);
    const corruptDatabase = 'preserve this corrupt lock database';
    writeFileSync(lockPath, corruptDatabase);

    expect(() => native.acquireExportLockNative!(root)).toThrow(/integrity|corrupt/i);
    expect(readFileSync(lockPath, 'utf8')).toBe(corruptDatabase);
  });

  it('serializes directory aliases by the same device and inode identity', () => {
    const root = target();
    const alias = join(target(), 'destination-alias');
    const native = loadNativeBinding();
    symlinkSync(root, alias, 'dir');
    const token = native.acquireExportLockNative!(root);
    expect(() => native.acquireExportLockNative!(alias)).toThrow(/locked/i);
    native.releaseExportLockNative!(token);
  });

  it('serializes equivalent destination paths while allowing a different destination', () => {
    const root = target();
    const other = target();
    mkdirSync(join(root, 'nested'));
    const native = loadNativeBinding();
    const token = native.acquireExportLockNative!(root);
    expect(() => makeExporter().export(join(root, 'nested', '..'), [doc('blocked.md', 'blocked')])).toThrow(/locked/i);
    expect(makeExporter().export(other, [doc('independent.md', 'independent')])).toEqual({ totalFiles: 1, writtenFiles: ['independent.md'] });
    native.releaseExportLockNative!(token);
  });

  it('ignores legacy marker files from prior lock implementations', () => {
    const root = target();
    writeFileSync(join(root, '.autodoc-export.lock'), JSON.stringify({ pid: 2147483647, token: 'abandoned-operation' }));
    writeFileSync(join(root, '.autodoc-export.lock.recovery'), JSON.stringify({ pid: 2147483647, token: 'abandoned-recovery' }));
    expect(makeExporter().export(root, [doc('guide.md', 'generated')])).toEqual({ totalFiles: 1, writtenFiles: ['guide.md'] });
  });

  it('preserves unowned staging-like user data and continues the export', () => {
    const root = target();
    const stage = join(root, '.autodoc-stage-user-data');
    mkdirSync(stage);
    writeFileSync(join(stage, 'notes.txt'), 'keep me');
    expect(makeExporter().export(root, [doc('guide.md', 'generated')])).toEqual({ totalFiles: 1, writtenFiles: ['guide.md'] });
    expect(readFileSync(join(stage, 'notes.txt'), 'utf8')).toBe('keep me');
  });

  it('rejects a preplanted recovery journal with an unauthenticated ownership marker', () => {
    const root = target();
    writeFileSync(join(root, 'package.json'), 'user content');
    const transaction = join(root, '.autodoc-stage-00000000-0000-4000-8000-000000000002');
    mkdirSync(transaction);
    writeFileSync(join(transaction, 'owner.json'), JSON.stringify({ schemaVersion: 1, transactionId: '00000000-0000-4000-8000-000000000002', root, mac: '0'.repeat(64) }));
    writeFileSync(join(transaction, 'journal.json'), JSON.stringify({ schemaVersion: 1, transactionId: '00000000-0000-4000-8000-000000000002', phase: 'committing', operations: [{ path: 'package.json', hadOriginal: true, originalHash: hash('older'), newHash: hash('user content') }] }));
    mkdirSync(join(transaction, 'backup'));
    writeFileSync(join(transaction, 'backup', 'package.json'), 'attacker content');
    expect(() => makeExporter().export(root, [doc('guide.md', 'generated')])).toThrow(/ownership/i);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('user content');
  });

  it('cleans authenticated staging that was interrupted before the journal', () => {
    const root = target();
    const transactionId = '00000000-0000-4000-8000-000000000003';
    const transaction = join(root, `.autodoc-stage-${transactionId}`);
    mkdirSync(transaction, { mode: 0o700 });
    const owner = { schemaVersion: 1, transactionId, root };
    writeFileSync(join(transaction, 'owner.json'), JSON.stringify({ ...owner, mac: sign(JSON.stringify(owner)) }));
    expect(makeExporter().export(root, [doc('guide.md', 'generated')])).toEqual({ totalFiles: 1, writtenFiles: ['guide.md'] });
    expect(() => readFileSync(join(transaction, 'owner.json'))).toThrow();
  });

  it('rejects a symlink destination root', () => {
    const parent = target();
    const actual = join(parent, 'actual');
    mkdirSync(actual);
    const alias = join(parent, 'alias');
    symlinkSync(actual, alias, 'dir');
    expect(() => makeExporter().export(alias, [doc('guide.md', 'generated')])).toThrow(/symlink/i);
  });

  it('rejects a symlink in an ancestor of the destination root', () => {
    const parent = target();
    const actual = join(parent, 'external');
    mkdirSync(actual);
    const alias = join(parent, 'alias');
    symlinkSync(actual, alias, 'dir');
    expect(() => makeExporter().export(join(alias, 'docs'), [doc('guide.md', 'generated')])).toThrow(/symlink/i);
  });

  it('rejects a symlinked private state directory before lock creation', () => {
    const parent = target();
    const stateRoot = join(parent, 'state-link');
    const actualState = join(parent, 'state');
    mkdirSync(actualState);
    symlinkSync(actualState, stateRoot, 'dir');
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateRoot;
    try {
      expect(() => new DocumentationExporter().export(join(parent, 'output'), [doc('guide.md', 'generated')])).toThrow(/symlink/i);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });
});
