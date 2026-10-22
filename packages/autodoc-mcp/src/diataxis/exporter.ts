import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { GeneratedDocFile } from './generator.js';
import { loadNativeBinding, type NativeBinding } from '../binding.js';

interface Manifest { schemaVersion: 1; scanId: string | null; files: Array<{ path: string; sha256: string }> }
interface JournalOperation { path: string; hadOriginal: boolean; originalHash?: string; newHash?: string }
interface Journal { schemaVersion: 1; transactionId: string; phase: 'committing' | 'committed'; operations: JournalOperation[]; mac?: string }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stagePrefix = '.autodoc-stage-';
export class DocumentationExporter {
  private readonly native: NativeBinding;
  private pinnedRootFd: number | null = null;
  private pinnedRootPath: string | null = null;

  constructor(native: NativeBinding = loadNativeBinding()) {
    this.native = native;
  }

  export(targetDir: string, docs: GeneratedDocFile[], scanId: string | null = null) {
    if (process.platform !== 'linux') {
      throw new Error('Documentation export requires Linux directory-descriptor protections on this platform.');
    }
    const requestedRoot = resolve(targetDir);
    this.assertNoSymlinkAncestors(requestedRoot);
    this.ensureDestinationDirectory(requestedRoot);
    this.assertNoSymlinkAncestors(requestedRoot);
    // Keep the validated lexical root. Re-resolving it with realpath here
    // would reopen a TOCTOU window if an ancestor changed after the walk.
    const root = requestedRoot;
    const manifestPath = resolve(root, '.autodoc-manifest.json');
    this.assertNoSymlinkPath(root, manifestPath);
    const rootFd = process.platform === 'linux' ? this.openPinnedRoot(root) : null;
    this.pinnedRootFd = rootFd;
    this.pinnedRootPath = root;
    let lockToken: string | null = null;
    try {
      lockToken = this.acquireLock(rootFd === null ? root : `/proc/self/fd/${rootFd}`);
      this.recoverInterruptedExports(root);
      return this.performExport(root, docs, scanId);
    } finally {
      try {
        if (lockToken !== null) this.releaseLock(lockToken);
      } finally {
        if (rootFd !== null) closeSync(rootFd);
        this.pinnedRootFd = null;
        this.pinnedRootPath = null;
      }
    }
  }

  private performExport(root: string, docs: GeneratedDocFile[], scanId: string | null) {
    const manifestPath = resolve(root, '.autodoc-manifest.json');
    const previous = this.readManifest(manifestPath);
    const oldFiles = new Map((previous?.files ?? []).map((file) => [file.path, file.sha256]));
    const nextFiles = new Map<string, string>();
    const transactionId = randomUUID();
    const staging = resolve(root, `${stagePrefix}${transactionId}`);
    const backup = resolve(staging, 'backup');
    this.withAnchoredPaths(root, [staging], ([path]) => mkdirSync(path, { recursive: false, mode: 0o700 }));
    const owner = { schemaVersion: 1, transactionId, root };
    const ownerPath = resolve(staging, 'owner.json');
    const ownerTemp = resolve(staging, 'owner.next');
    this.withAnchoredPaths(root, [ownerTemp], ([path]) => writeFileSync(path, JSON.stringify({ ...owner, mac: this.sign(JSON.stringify(owner)) }), { flag: 'wx', mode: 0o600 }));
    this.withAnchoredPaths(root, [ownerTemp, ownerPath], ([source, destination]) => linkSync(source, destination));
    this.withAnchoredPaths(root, [ownerTemp], ([path]) => unlinkSync(path));

    try {
      for (const doc of docs) {
        const relPath = this.safeRelativePath(doc.relativePath);
        const target = resolve(root, relPath);
        this.assertNoSymlinkPath(root, target);
        const outputHash = hash(doc.content);
        if (nextFiles.has(relPath)) throw new Error(`Export conflict: duplicate output path ${relPath}`);
        nextFiles.set(relPath, outputHash);
        if (existsSync(target)) {
          const ownedHash = oldFiles.get(relPath);
          if (!ownedHash || hash(readFileSync(target)) !== ownedHash) throw new Error(`Export conflict: ${relPath} is not an unchanged AutoDoc artifact`);
        }
        const staged = resolve(staging, 'new', relPath);
        this.withAnchoredPaths(root, [staged], ([path]) => writeFileSync(path, doc.content, { flag: 'wx' }));
      }

      for (const [relPath, priorHash] of oldFiles) {
        if (nextFiles.has(relPath)) continue;
        const target = resolve(root, relPath);
        this.assertNoSymlinkPath(root, target);
        if (existsSync(target) && hash(readFileSync(target)) !== priorHash) throw new Error(`Export conflict: stale artifact ${relPath} was edited`);
      }

      const manifest: Manifest = { schemaVersion: 1, scanId, files: [...nextFiles].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)) };
      const manifestContent = JSON.stringify(manifest, null, 2) + '\n';
      const stagedManifest = resolve(staging, 'manifest.json');
      this.withAnchoredPaths(root, [stagedManifest], ([path]) => writeFileSync(path, manifestContent, { flag: 'wx' }));

      const operations: JournalOperation[] = [];
      for (const relPath of nextFiles.keys()) {
        const target = resolve(root, relPath);
        const exists = existsSync(target);
        operations.push({ path: relPath, hadOriginal: exists, ...(exists ? { originalHash: hash(readFileSync(target)) } : {}), newHash: nextFiles.get(relPath) });
      }
      for (const [relPath] of oldFiles) {
        if (nextFiles.has(relPath)) continue;
        const target = resolve(root, relPath);
        const exists = existsSync(target);
        operations.push({ path: relPath, hadOriginal: exists, ...(exists ? { originalHash: hash(readFileSync(target)) } : {}) });
      }
      const hadManifest = existsSync(manifestPath);
      operations.push({ path: '.autodoc-manifest.json', hadOriginal: hadManifest, ...(hadManifest ? { originalHash: hash(readFileSync(manifestPath)) } : {}), newHash: hash(manifestContent) });
      this.writeJournal(staging, { schemaVersion: 1, transactionId, phase: 'committing', operations });

      for (const operation of operations) {
        const target = resolve(root, operation.path);
        this.assertNoSymlinkPath(root, target);
        const backupPath = resolve(backup, operation.path);
        if (existsSync(target)) {
          this.withAnchoredPaths(root, [backupPath], () => undefined);
          this.assertCanonicalParent(root, target);
          this.assertCanonicalParent(root, backupPath);
          this.withAnchoredPaths(root, [target, backupPath], ([source, destination]) => renameSync(source, destination));
          if (operation.originalHash && hash(readFileSync(backupPath)) !== operation.originalHash) {
            this.withAnchoredPaths(root, [backupPath, target], ([source, destination]) => renameSync(source, destination));
            throw new Error(`Export conflict: ${operation.path} changed during export`);
          }
        }
        if (operation.newHash) {
          const staged = operation.path === '.autodoc-manifest.json' ? stagedManifest : resolve(staging, 'new', operation.path);
          this.withAnchoredPaths(root, [target], () => undefined);
          this.assertCanonicalParent(root, staged);
          this.assertCanonicalParent(root, target);
          try {
            this.withAnchoredPaths(root, [staged, target], ([source, destination]) => linkSync(source, destination));
            this.withAnchoredPaths(root, [staged], ([source]) => unlinkSync(source));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Export conflict: ${operation.path} was created during export`);
            throw error;
          }
        }
      }

      this.writeJournal(staging, { schemaVersion: 1, transactionId, phase: 'committed', operations });
      this.withAnchoredPaths(root, [staging], ([path]) => rmSync(path, { recursive: true, force: true }));
      return { totalFiles: nextFiles.size, writtenFiles: [...nextFiles.keys()] };
    } catch (error) {
      if (existsSync(resolve(staging, 'journal.json'))) this.recoverTransaction(root, staging);
      else this.withAnchoredPaths(root, [staging], ([path]) => rmSync(path, { recursive: true, force: true }));
      throw error;
    }
  }

  private acquireLock(path: string): string {
    try {
      return this.native.acquireExportLockNative(path);
    } catch (error) {
      throw new Error(`Export conflict: destination is locked or native lock failed (${String((error as Error).message)})`);
    }
  }

  private releaseLock(token: string) {
    this.native.releaseExportLockNative(token);
  }

  private recoverInterruptedExports(root: string) {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(stagePrefix)) continue;
      const transaction = resolve(root, name);
      if (lstatSync(transaction).isSymbolicLink()) throw new Error('Export conflict: symlink transaction directory');
      if (!new RegExp(`^${stagePrefix}[0-9a-f-]{36}$`).test(name)) continue;
      if (!existsSync(resolve(transaction, 'owner.json')) && !existsSync(resolve(transaction, 'journal.json'))) continue;
      this.recoverTransaction(root, transaction);
    }
  }

  private recoverTransaction(root: string, transaction: string) {
    const transactionId = transaction.slice(transaction.lastIndexOf(stagePrefix) + stagePrefix.length);
    let owner: { schemaVersion?: number; transactionId?: string; root?: string; mac?: string };
    try { owner = JSON.parse(readFileSync(resolve(transaction, 'owner.json'), 'utf8')) as typeof owner; }
    catch { throw new Error('Export conflict: staging ownership marker is missing or invalid'); }
    const ownerPayload = { schemaVersion: owner.schemaVersion, transactionId: owner.transactionId, root: owner.root };
    if (owner.schemaVersion !== 1 || owner.transactionId !== transactionId || owner.root !== root || !owner.mac || !this.verify(JSON.stringify(ownerPayload), owner.mac)) throw new Error('Export conflict: staging ownership does not match its directory');
    const journalPath = resolve(transaction, 'journal.json');
    if (!existsSync(journalPath)) {
      this.withAnchoredPaths(root, [transaction], ([path]) => rmSync(path, { recursive: true, force: true }));
      return;
    }
    let journal: Journal;
    try { journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal; }
    catch { throw new Error('Export conflict: interrupted export journal is invalid'); }
    const journalPayload = { schemaVersion: journal.schemaVersion, transactionId: journal.transactionId, phase: journal.phase, operations: journal.operations };
    if (journal.schemaVersion !== 1 || journal.transactionId !== transactionId || !journal.mac || !this.verify(JSON.stringify(journalPayload), journal.mac) || !['committing', 'committed'].includes(journal.phase) || !Array.isArray(journal.operations)) {
      throw new Error('Export conflict: unsupported interrupted export journal');
    }
    if (journal.phase === 'committing') {
      for (const operation of [...journal.operations].reverse()) {
        const relPath = this.safeRelativePath(operation.path);
        const target = resolve(root, relPath);
        const backup = resolve(transaction, 'backup', relPath);
        this.assertNoSymlinkPath(root, target);
        if (operation.hadOriginal && existsSync(backup)) {
          if (!operation.originalHash || hash(readFileSync(backup)) !== operation.originalHash) throw new Error(`Export conflict: backup hash is invalid for ${relPath}`);
          // Never replace a basename during recovery. A present target may be the
          // committed output or a later user edit; both are preserved.
          if (!existsSync(target)) {
            try {
              this.withAnchoredPaths(root, [backup, target], ([source, destination]) => linkSync(source, destination));
              this.withAnchoredPaths(root, [backup], ([path]) => unlinkSync(path));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
          }
        } else if (!operation.hadOriginal && operation.newHash && existsSync(target) && hash(readFileSync(target)) === operation.newHash) {
          const quarantine = resolve(transaction, 'recovery-conflicts', randomUUID());
          this.withAnchoredPaths(root, [target, quarantine], ([source, destination]) => renameSync(source, destination));
          if (hash(readFileSync(quarantine)) !== operation.newHash) {
            try {
              this.withAnchoredPaths(root, [quarantine, target], ([source, destination]) => linkSync(source, destination));
              this.withAnchoredPaths(root, [quarantine], ([path]) => unlinkSync(path));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              // Keep the authenticated journal and quarantined user data for manual recovery.
            }
            throw new Error(`Export conflict: ${relPath} changed during interrupted export recovery`);
          }
          this.withAnchoredPaths(root, [quarantine], ([path]) => rmSync(path, { force: true }));
        } else if (operation.hadOriginal && !existsSync(backup) && !existsSync(target)) {
          throw new Error(`Export conflict: cannot safely recover missing original ${relPath}`);
        }
      }
    }
    this.withAnchoredPaths(root, [transaction], ([path]) => rmSync(path, { recursive: true, force: true }));
  }

  private writeJournal(transaction: string, journal: Journal) {
    const path = resolve(transaction, 'journal.json');
    const temporary = resolve(transaction, 'journal.next');
    const payload = { schemaVersion: journal.schemaVersion, transactionId: journal.transactionId, phase: journal.phase, operations: journal.operations };
    this.withAnchoredPaths(transaction, [temporary], ([anchored]) => writeFileSync(anchored, JSON.stringify({ ...payload, mac: this.sign(JSON.stringify(payload)) }), { flag: 'w', mode: 0o600 }));
    this.withAnchoredPaths(transaction, [temporary, path], ([source, destination]) => renameSync(source, destination));
  }

  private sign(value: string): string {
    return createHmac('sha256', this.exportKey()).update(value).digest('hex');
  }

  private verify(value: string, mac: string): boolean {
    const expected = Buffer.from(this.sign(value), 'hex');
    const provided = Buffer.from(mac, 'hex');
    return expected.length === provided.length && expected.equals(provided);
  }

  private exportKey(): Buffer {
    const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    const keyDir = join(stateRoot, 'autodoc');
    const keyPath = join(keyDir, 'export.key');
    this.assertPrivateStatePath(keyDir);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    this.assertPrivateStatePath(keyDir);
    try {
      const temporary = join(keyDir, `.export-key-${randomUUID()}`);
      const fd = openSync(temporary, 'wx', 0o600);
      const key = randomBytes(32);
      try { writeFileSync(fd, key); } finally { closeSync(fd); }
      try { linkSync(temporary, keyPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally { rmSync(temporary, { force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (lstatSync(keyPath).isSymbolicLink() || !statSync(keyPath).isFile() || (statSync(keyPath).mode & 0o077) !== 0 || (typeof process.getuid === 'function' && statSync(keyPath).uid !== process.getuid())) {
      throw new Error('Export conflict: AutoDoc export key is not a private regular file');
    }
    const key = readFileSync(keyPath);
    if (key.length !== 32) throw new Error('Export conflict: AutoDoc export key is invalid');
    return key;
  }

  private assertPrivateStatePath(target: string) {
    const volumeRoot = parse(target).root;
    let current = volumeRoot;
    const parts = target.slice(volumeRoot.length).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]);
      if (!existsSync(current)) break;
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Export conflict: AutoDoc signing key path contains a symlink or non-directory');
      const safeStickyRootDirectory = stats.uid === 0 && (stats.mode & 0o1000) !== 0;
      if (((stats.mode & 0o022) !== 0 && !safeStickyRootDirectory) || (typeof process.getuid === 'function' && stats.uid !== 0 && stats.uid !== process.getuid())) {
        throw new Error('Export conflict: AutoDoc signing key directory is writable by other users or has unexpected ownership');
      }
      if (index === parts.length - 1 && (stats.mode & 0o077) !== 0) throw new Error('Export conflict: AutoDoc signing key directory must be private');
    }
  }

  private readManifest(path: string): Manifest | null {
    if (!existsSync(path)) return null;
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Export conflict: AutoDoc manifest is invalid'); }
    const manifest = value as Manifest;
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Export conflict: unsupported AutoDoc manifest');
    for (const file of manifest.files) this.safeRelativePath(file.path);
    return manifest;
  }

  private safeRelativePath(path: string): string {
    if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) throw new Error(`Export conflict: unsafe output path ${path}`);
    const normalized = resolve('/', path).slice(1);
    if (!normalized || normalized === '.') throw new Error(`Export conflict: unsafe output path ${path}`);
    return normalized;
  }

  private assertNoSymlinkPath(root: string, target: string) {
    const rel = relative(root, target);
    let current = root;
    for (const part of rel.split(sep)) {
      if (!part) continue;
      current = resolve(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Export conflict: symlink output path ${part}`);
    }
  }

  private assertNoSymlinkAncestors(target: string) {
    const volumeRoot = parse(target).root;
    let current = volumeRoot;
    for (const part of target.slice(volumeRoot.length).split(sep)) {
      if (!part) continue;
      current = resolve(current, part);
      if (!existsSync(current)) break;
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Export conflict: symlink in destination path ${current}`);
    }
  }

  private assertCanonicalParent(root: string, target: string) {
    let parent: string;
    try { parent = realpathSync(dirname(target)); }
    catch { throw new Error(`Export conflict: destination parent is unavailable for ${relative(root, target)}`); }
    const rel = relative(root, parent);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Export conflict: destination parent escaped the canonical export root for ${relative(root, target)}`);
    }
  }

  private ensureDestinationDirectory(target: string) {
    if (process.platform !== 'linux') {
      mkdirSync(target, { recursive: true });
      return;
    }
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const volumeRoot = parse(target).root;
    const opened: number[] = [];
    try {
      let parentFd = openSync(volumeRoot, flags);
      opened.push(parentFd);
      for (const part of target.slice(volumeRoot.length).split(sep).filter(Boolean)) {
        const childPath = `/proc/self/fd/${parentFd}/${part}`;
        let childFd: number;
        try { childFd = openSync(childPath, flags); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          try { mkdirSync(childPath, { mode: 0o700 }); }
          catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
          childFd = openSync(childPath, flags);
        }
        opened.push(childFd);
        parentFd = childFd;
      }
    } finally {
      for (const fd of opened.reverse()) closeSync(fd);
    }
  }

  private openPinnedRoot(root: string): number {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const volumeRoot = parse(root).root;
    const opened: number[] = [];
    try {
      let currentFd = openSync(volumeRoot, flags);
      opened.push(currentFd);
      for (const part of root.slice(volumeRoot.length).split(sep).filter(Boolean)) {
        currentFd = openSync(`/proc/self/fd/${currentFd}/${part}`, flags);
        opened.push(currentFd);
      }
      const pinnedFd = currentFd;
      opened.pop();
      return pinnedFd;
    } finally {
      for (const fd of opened.reverse()) closeSync(fd);
    }
  }

  /**
   * On Linux, pin every parent directory with O_NOFOLLOW and perform mutations
   * through /proc/self/fd paths. A concurrent rename/symlink swap cannot retarget
   * the operation after the directory descriptors are opened.
   */
  private withAnchoredPaths<T>(root: string, targets: string[], operation: (paths: string[]) => T): T {
    if (process.platform !== 'linux') {
      for (const target of targets) this.assertCanonicalParent(root, target);
      return operation(targets);
    }

    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const opened: number[] = [];
    try {
      const pinnedRoot = this.pinnedRootFd;
      const pinnedPath = this.pinnedRootPath;
      let rootFd: number;
      if (pinnedRoot !== null && pinnedPath !== null) {
        rootFd = pinnedRoot;
        const rootRel = relative(pinnedPath, root);
        if (rootRel === '..' || rootRel.startsWith(`..${sep}`) || isAbsolute(rootRel)) {
          throw new Error('Export conflict: operation root escaped the pinned destination');
        }
        for (const part of rootRel.split(sep).filter(Boolean)) {
          rootFd = openSync(`/proc/self/fd/${rootFd}/${part}`, directoryFlags);
          opened.push(rootFd);
        }
      } else {
        const volumeRoot = parse(root).root;
        rootFd = openSync(volumeRoot, directoryFlags);
        opened.push(rootFd);
        for (const part of root.slice(volumeRoot.length).split(sep).filter(Boolean)) {
          const nextRootFd = openSync(`/proc/self/fd/${rootFd}/${part}`, directoryFlags);
          opened.push(nextRootFd);
          rootFd = nextRootFd;
        }
      }
      const anchored = targets.map((target) => {
        const rel = relative(root, target);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`Export conflict: path escaped the canonical export root: ${rel}`);
        }
        const parts = rel.split(sep).filter(Boolean);
        let parentFd = rootFd;
        for (const part of parts.slice(0, -1)) {
          if (part === '.' || part === '..') throw new Error('Export conflict: unsafe directory component');
          const childPath = `/proc/self/fd/${parentFd}/${part}`;
          let childFd: number;
          try {
            childFd = openSync(childPath, directoryFlags);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            try { mkdirSync(childPath, { mode: 0o700 }); }
            catch (mkdirError) {
              if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
            }
            childFd = openSync(childPath, directoryFlags);
          }
          opened.push(childFd);
          parentFd = childFd;
        }
        const basename = parts.at(-1);
        if (!basename || basename === '.' || basename === '..') throw new Error('Export conflict: unsafe path basename');
        return `/proc/self/fd/${parentFd}/${basename}`;
      });
      return operation(anchored);
    } finally {
      for (const fd of opened.reverse()) closeSync(fd);
    }
  }
}
