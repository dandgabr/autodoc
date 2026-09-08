import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

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
  totalFiles: number;
  totalLoc: number;
  totalSymbols?: number;
  totalEdges?: number;
  languages: string[];
  cachePath: string;
}

export interface NativeBinding {
  initLogger(): void;
  ping(traceId: string): PingResponse;
  triggerPanicTest(reason: string): string;
  sanitizeContent?(content: string): { sanitizedText: string; redactionCount: number };
  wrapUntrusted?(content: string, origin: string, file: string, symbol: string): string;
  scanRepositoryNative?(repoPath: string): NativeScanResult;
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
