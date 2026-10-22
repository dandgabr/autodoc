import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import type { SnapshotPage } from "./analysis/contracts.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PingResponse {
  traceId: string;
  status: string;
  version: string;
  rustcVersion: string;
  timestampMs: number;
}

export interface NativeScanResult {
  scanId?: string;
  activeScanId?: string | null;
  totalFiles: number;
  candidateFiles: number;
  filesWithErrors: number;
  totalLoc: number;
  totalSymbols?: number;
  totalEdges?: number;
  languages: string[];
  cachePath: string;
  analysisState: "complete" | "partial" | "failed";
  coverageState?: "complete" | "partial";
  diagnostics: Array<{ stage: string; code: string; path?: string; message: string }>;
}

/** Optional scan resource budgets; omitted values use the native safe defaults. */
export interface NativeScanOptions {
  maxSourceBytes?: number;
  workers?: number;
  queueCapacity?: number;
  batchSize?: number;
}

export interface NativeBinding {
  initLogger(): void;
  ping(traceId: string): PingResponse;
  triggerPanicTest(reason: string): string;
  sanitizeContent?(content: string): { sanitizedText: string; redactionCount: number };
  wrapUntrusted?(content: string, origin: string, file: string, symbol: string): string;
  scanRepositoryNative?(repoPath: string, options?: NativeScanOptions): NativeScanResult;
  readRepositorySnapshotNative?(repoPath: string, scanId?: string): string;
  readSnapshotPageNative?(repoPath: string, scanId: string, collection: SnapshotPage["collection"], cursor: string | null, limit: number): string;
  readVerifiedSourceNative?(repoPath: string, relativePath: string, expectedSha256: string): Uint8Array;
  /** Acquires a lock for the directory identity resolved by this path (normally /proc/self/fd/N). */
  acquireExportLockNative(directoryPath: string): string;
  releaseExportLockNative(token: string): void;
}

/**
 * Safely loads the native NAPI-RS binding from candidate binary locations.
 */
export function loadNativeBinding(): NativeBinding {
  const candidatePaths = [
    // Local package build output
    join(__dirname, "../../../crates/autodoc-core/autodoc-core.linux-x64-gnu.node"),
    join(__dirname, "../../../crates/autodoc-core/index.node"),
    // Target debug / release build outputs
    join(__dirname, "../../../target/debug/libautodoc_core.so"),
    join(__dirname, "../../../target/release/libautodoc_core.so"),
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      try {
        const binding = require(candidate);
        return binding as NativeBinding;
      } catch (e) {
        // Continue checking candidates
      }
    }
  }

  // Fallback to resolving via package name if installed
  try {
    const binding = require("@autodoc/core");
    return binding as NativeBinding;
  } catch (err: any) {
    throw new Error(
      `AUTODOC_E402: Failed to load native AutoDoc binding. Searched candidates: ${candidatePaths.join(
        ", "
      )}. Reason: ${err?.message}`
    );
  }
}
