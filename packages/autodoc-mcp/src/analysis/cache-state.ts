import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ActiveCacheState =
  | { state: 'active'; scanId: string }
  | { state: 'not_scanned' }
  | { state: 'failed' };

const resolvedCachePaths = new Map<string, string>();

export function registerRepositoryCachePath(repoPath: string, cachePath: string) {
  resolvedCachePaths.set(resolve(repoPath), resolve(cachePath));
}

export function repositoryCachePath(repoPath: string): string {
  return resolvedCachePaths.get(resolve(repoPath)) ?? join(repoPath, '.autodoc', 'cache.db');
}

/** Legacy cache rows without an active scan pointer are not current evidence. */
export function readActiveCacheState(dbPath: string): ActiveCacheState {
  if (!existsSync(dbPath)) return { state: 'not_scanned' };
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_state'").get();
      if (!table) return { state: 'not_scanned' };
      const row = db.prepare('SELECT active_scan_id FROM scan_state WHERE singleton=1').get() as { active_scan_id: string | null } | undefined;
      return row?.active_scan_id ? { state: 'active', scanId: row.active_scan_id } : { state: 'not_scanned' };
    } finally { db.close(); }
  } catch {
    return { state: 'failed' };
  }
}
