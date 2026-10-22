import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ target: '', outside: '', hits: 0, enabled: false, phase: 'lstat' as 'lstat' | 'realpath' | 'link' | 'recovery-read' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync(path: Parameters<typeof actual.realpathSync>[0], ...args: Parameters<typeof actual.realpathSync> extends [unknown, ...infer R] ? R : never) {
      const resolved = actual.realpathSync(path, ...args as never);
      if (race.enabled && race.phase === 'realpath' && String(path) === race.target) {
        race.enabled = false;
        race.hits += 1;
        actual.renameSync(race.target, `${race.target}.held`);
        actual.symlinkSync(race.outside, race.target);
      }
      return resolved;
    },
    linkSync(existingPath: Parameters<typeof actual.linkSync>[0], newPath: Parameters<typeof actual.linkSync>[1]) {
      if (race.enabled && race.phase === 'link' && String(newPath).endsWith('/guide.md')) {
        race.enabled = false;
        race.hits += 1;
        actual.renameSync(race.target, `${race.target}.held`);
        actual.symlinkSync(race.outside, race.target);
      }
      return actual.linkSync(existingPath, newPath);
    },
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], ...args: Parameters<typeof actual.readFileSync> extends [unknown, ...infer R] ? R : never) {
      const value = actual.readFileSync(path, ...args as never);
      if (race.enabled && race.phase === 'recovery-read' && String(path) === race.target) {
        race.enabled = false;
        race.hits += 1;
        actual.writeFileSync(path, 'manual concurrent edit');
      }
      return value;
    },
    lstatSync(path: Parameters<typeof actual.lstatSync>[0], ...args: Parameters<typeof actual.lstatSync> extends [unknown, ...infer R] ? R : never) {
      const stats = actual.lstatSync(path, ...args as never);
      if (race.enabled && race.phase === 'lstat' && String(path) === race.target && stats.isDirectory()) {
        race.hits += 1;
        if (race.hits === 2) {
          race.enabled = false;
          actual.renameSync(race.target, `${race.target}.held`);
          actual.symlinkSync(race.outside, race.target);
        }
      }
      return stats;
    },
  };
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentationExporter } from '../src/diataxis/exporter.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  race.enabled = false;
  race.hits = 0;
  race.phase = 'lstat';
});

describe('export destination symlink races', () => {
  it('does not write outside the canonical destination when a checked parent is swapped', () => {
    const base = mkdtempSync(join(tmpdir(), 'autodoc-export-race-'));
    roots.push(base);
    const root = join(base, 'destination');
    const nested = join(root, 'nested');
    const outside = join(base, 'outside');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    race.target = nested;
    race.outside = outside;
    race.enabled = true;

    expect(() => new DocumentationExporter().export(root, [{ relativePath: 'nested/guide.md', content: 'generated', title: 'Fixture', quadrant: 'reference' }])).toThrow(/escaped|symlink/i);
    expect(race.hits).toBe(2);
    expect(() => readFileSync(join(outside, 'guide.md'))).toThrow();
  });

  it('keeps the mutation anchored when the parent is swapped after realpath returns', () => {
    const base = mkdtempSync(join(tmpdir(), 'autodoc-export-race-after-realpath-'));
    roots.push(base);
    const root = join(base, 'destination');
    const nested = join(root, 'nested');
    const outside = join(base, 'outside');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    race.target = nested;
    race.outside = outside;
    race.phase = 'realpath';
    race.enabled = true;

    expect(() => new DocumentationExporter().export(root, [{ relativePath: 'nested/guide.md', content: 'generated', title: 'Fixture', quadrant: 'reference' }])).toThrow();
    expect(race.hits).toBe(1);
    expect(() => readFileSync(join(outside, 'guide.md'))).toThrow();
  });

  it('does not adopt a different root when its ancestor is swapped during path resolution', () => {
    const base = mkdtempSync(join(tmpdir(), 'autodoc-export-root-race-'));
    roots.push(base);
    const root = join(base, 'destination');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    race.target = root;
    race.outside = outside;
    race.phase = 'realpath';
    race.enabled = true;

    expect(() => new DocumentationExporter().export(root, [{ relativePath: 'guide.md', content: 'generated', title: 'Fixture', quadrant: 'reference' }])).toThrow();
    expect(race.hits).toBe(1);
    expect(() => readFileSync(join(outside, 'guide.md'))).toThrow();
    expect(() => readFileSync(join(outside, '.autodoc-export-lock.db'))).toThrow();
  });

  it('keeps the mutation inside the pinned parent when the parent is swapped after descriptors open', () => {
    const base = mkdtempSync(join(tmpdir(), 'autodoc-export-race-after-open-'));
    roots.push(base);
    const root = join(base, 'destination');
    const nested = join(root, 'nested');
    const outside = join(base, 'outside');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    race.target = nested;
    race.outside = outside;
    race.phase = 'link';
    race.enabled = true;

    new DocumentationExporter().export(root, [{ relativePath: 'nested/guide.md', content: 'generated', title: 'Fixture', quadrant: 'reference' }]);
    expect(race.hits).toBe(1);
    expect(readFileSync(join(`${nested}.held`, 'guide.md'), 'utf8')).toBe('generated');
    expect(() => readFileSync(join(outside, 'guide.md'))).toThrow();
  });

  it('preserves an edit that races recovery removal and leaves the journal for retry', () => {
    const base = mkdtempSync(join(tmpdir(), 'autodoc-export-recovery-race-'));
    roots.push(base);
    const root = join(base, 'destination');
    const state = join(base, 'state');
    const key = Buffer.from('01234567890123456789012345678901');
    const oldState = process.env.XDG_STATE_HOME;
    mkdirSync(root);
    mkdirSync(join(state, 'autodoc'), { recursive: true, mode: 0o700 });
    writeFileSync(join(state, 'autodoc', 'export.key'), key, { mode: 0o600 });
    process.env.XDG_STATE_HOME = state;
    const transactionId = '00000000-0000-4000-8000-000000000004';
    const transaction = join(root, `.autodoc-stage-${transactionId}`);
    const guide = join(root, 'guide.md');
    mkdirSync(join(transaction, 'backup'), { recursive: true });
    const owner = { schemaVersion: 1, transactionId, root };
    const sign = (payload: string) => createHmac('sha256', key).update(payload).digest('hex');
    writeFileSync(join(transaction, 'owner.json'), JSON.stringify({ ...owner, mac: sign(JSON.stringify(owner)) }));
    writeFileSync(guide, 'generated');
    const journal = {
      schemaVersion: 1,
      transactionId,
      phase: 'committing',
      operations: [{ path: 'guide.md', hadOriginal: false, newHash: createHash('sha256').update('generated').digest('hex') }],
    };
    writeFileSync(join(transaction, 'journal.json'), JSON.stringify({ ...journal, mac: sign(JSON.stringify(journal)) }));
    race.target = guide;
    race.phase = 'recovery-read';
    race.enabled = true;

    try {
      expect(() => new DocumentationExporter().export(root, [{ relativePath: 'next.md', content: 'next', title: 'Fixture', quadrant: 'reference' }])).toThrow(/changed during interrupted export recovery/i);
      expect(race.hits).toBe(1);
      expect(readFileSync(guide, 'utf8')).toBe('manual concurrent edit');
      expect(readFileSync(join(transaction, 'journal.json'), 'utf8')).toContain(transactionId);
    } finally {
      if (oldState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldState;
    }
  });
});
