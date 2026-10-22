import { realpathSync } from 'node:fs';
import type { NativeBinding } from '../binding.js';
import { loadNativeBinding } from '../binding.js';
import {
  parseSnapshotMetadata,
  parseSnapshotPage,
  type SnapshotMetadata,
  type SnapshotPage,
} from './contracts.js';

export type SnapshotCollection = SnapshotPage['collection'];

export class SnapshotReadError extends Error {
  constructor(readonly status: 'NOT_SCANNED' | 'SNAPSHOT_UNAVAILABLE' | 'FAILED', message: string) {
    super(message);
    this.name = 'SnapshotReadError';
  }
}

export interface SnapshotContext {
  readonly repositoryRoot: string;
  readonly scanId: string;
  readonly metadata: SnapshotMetadata;
  readPage(collection: SnapshotCollection, cursor?: string | null, limit?: number): SnapshotPage;
}

function nativeError(error: unknown): SnapshotReadError {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes('NOT_SCANNED') ? 'NOT_SCANNED'
    : message.includes('SNAPSHOT_UNAVAILABLE') || message.includes('INVALID_CURSOR') ? 'SNAPSHOT_UNAVAILABLE'
      : 'FAILED';
  return new SnapshotReadError(status, message);
}

/** Load metadata once and return a page reader permanently bound to that generation. */
export async function loadSnapshot(repoPath: string, scanId?: string, binding: NativeBinding = loadNativeBinding()): Promise<SnapshotContext> {
  if (!binding.readRepositorySnapshotNative || !binding.readSnapshotPageNative) {
    throw new SnapshotReadError('FAILED', 'Native snapshot read APIs are unavailable; rebuild @autodoc/core.');
  }
  let repositoryRoot: string;
  try { repositoryRoot = realpathSync(repoPath); }
  catch (error) { throw new SnapshotReadError('NOT_SCANNED', `Repository root is unavailable: ${String(error)}`); }

  let metadata: SnapshotMetadata;
  try {
    metadata = parseSnapshotMetadata(JSON.parse(binding.readRepositorySnapshotNative(repositoryRoot, scanId)));
  } catch (error) { throw nativeError(error); }
  if (metadata.repositoryRoot !== repositoryRoot || (scanId && metadata.scanId !== scanId)) {
    throw new SnapshotReadError('SNAPSHOT_UNAVAILABLE', 'Snapshot metadata does not match the requested repository or generation.');
  }
  const pinnedScanId = metadata.scanId;
  return Object.freeze({
    repositoryRoot,
    scanId: pinnedScanId,
    metadata,
    readPage(collection: SnapshotCollection, cursor: string | null = null, limit = 50): SnapshotPage {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new SnapshotReadError('FAILED', 'INVALID_LIMIT: snapshot page limit must be between 1 and 500.');
      }
      try {
        const raw = binding.readSnapshotPageNative!(repositoryRoot, pinnedScanId, collection, cursor, limit);
        return parseSnapshotPage(JSON.parse(raw), { scanId: pinnedScanId, repositoryRoot, collection });
      } catch (error) { throw nativeError(error); }
    },
  });
}
