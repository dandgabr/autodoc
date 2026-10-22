import type { InventoryFile } from './contracts.js';
import { loadNativeBinding } from '../binding.js';
import type { SnapshotContext } from './snapshot.js';

export type InventoryCategory = InventoryFile['category'];
export type InventorySnapshotContext = SnapshotContext;
export type NativeVerifiedReader = (repositoryRoot: string, path: string, expectedSha256: string) => Uint8Array;

export class StaleSourceError extends Error {
  constructor(readonly path: string, readonly expectedHash: string, readonly actualHash: string | null, options?: ErrorOptions) {
    super(`STALE source for ${path}: expected ${expectedHash}${actualHash ? `, received ${actualHash}` : ''}`, options);
    this.name = 'StaleSourceError';
  }
}

function listInventory(context: InventorySnapshotContext): InventoryFile[] {
  const files: InventoryFile[] = [];
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const page = context.readPage('files', cursor, 500);
    if (page.scanId !== context.scanId || page.repositoryRoot !== context.repositoryRoot || page.collection !== 'files') {
      throw new Error('Inventory page does not belong to the pinned scan and repository root');
    }
    files.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor)) throw new Error('Inventory pagination returned a repeated cursor');
    if (cursor) visited.add(cursor);
  } while (cursor);
  return files;
}

export function selectInventoryFiles(context: InventorySnapshotContext, categories: InventoryCategory[]): InventoryFile[] {
  const allowed = new Set(categories);
  return listInventory(context).filter((file) => allowed.has(file.category) && !file.excludedReason && !file.readError);
}

const inventoryCache = new WeakMap<InventorySnapshotContext, InventoryFile[]>();

export function readInventoryFiles(context: InventorySnapshotContext): InventoryFile[] {
  const cached = inventoryCache.get(context);
  if (cached) return cached;
  const files = listInventory(context);
  inventoryCache.set(context, files);
  return files;
}

export function readVerifiedSource(
  context: InventorySnapshotContext,
  path: string,
  nativeRead: NativeVerifiedReader = (root, sourcePath, hash) => {
    const binding = loadNativeBinding() as ReturnType<typeof loadNativeBinding> & { readVerifiedSourceNative?: NativeVerifiedReader };
    if (!binding.readVerifiedSourceNative) throw new Error('Native verified source reader is unavailable; rebuild @autodoc/core');
    return binding.readVerifiedSourceNative(root, sourcePath, hash);
  },
): Buffer {
  const entry = readInventoryFiles(context).find((file) => file.path === path);
  if (!entry) throw new Error(`Path ${path} is not in scan inventory ${context.scanId}`);
  if (entry.excludedReason) throw new Error(`Path ${path} is excluded from scan inventory: ${entry.excludedReason}`);
  if (entry.readError) throw new StaleSourceError(entry.path, entry.contentSha256 ?? 'unavailable', null);
  if (!entry.contentSha256) throw new Error(`Path ${path} has no verified source hash (metadata-only or unsupported)`);
  try {
    return Buffer.from(nativeRead(context.repositoryRoot, entry.path, entry.contentSha256));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/STALE_SOURCE expected=([a-f0-9]{64}) actual=([a-f0-9]{64})/i);
    if (match) throw new StaleSourceError(entry.path, match[1], match[2], { cause: error });
    throw new StaleSourceError(entry.path, entry.contentSha256, null, { cause: error });
  }
}
