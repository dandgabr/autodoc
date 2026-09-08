/**
 * LLM provider abstraction for AutoDoc.
 *
 * Default adapter: node-llama-cpp (same-process GGUF inference, JSON Schema
 * enforcement at generation level, lazy-loaded optional dependency).
 * Alternative: llama-server (llama.cpp OpenAI-compatible HTTP endpoint).
 *
 * Every consumer must tolerate provider unavailability: callers use
 * `isAvailable()` and fall back to deterministic behavior.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODEL_CATALOG, PROFILE_ORDER, type ModelProfile, type ModelSpec } from "./models.js";
import type { HostCapabilities } from "./hardware.js";

export interface LlmGenerationOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly kind: "node-llama-cpp" | "llama-server";
  readonly model: {
    profile: ModelProfile;
    modelId: string;
    contextTokens: number;
    device: string;
  };
  isAvailable(): Promise<boolean>;
  /** Raw text completion over a chat prompt. */
  complete(prompt: string, system: string, options?: LlmGenerationOptions): Promise<string>;
  dispose(): Promise<void>;
}

export interface ResolvedModel {
  spec: ModelSpec;
  /** Local path to the GGUF weights (single file or split shards dir). */
  weightsPath: string | undefined;
  source: "operator-override" | "auto-selected" | "env-configured";
  overrideValue?: string;
}

/**
 * Resolve the model to run: operator override wins, otherwise the largest
 * profile that fits the host budget with a safety margin.
 */
export function resolveModel(options: {
  hostCapabilities: HostCapabilities;
  operatorProfile?: string;
  operatorModelPath?: string;
  envModelPath?: string;
  envProfile?: string;
}): ResolvedModel | { error: string } {
  if (options.operatorModelPath || options.envModelPath) {
    const path = options.operatorModelPath ?? options.envModelPath;
    if (!path) return { error: "AUTODOC_LLM_E400: model path missing" };
    const spec = guessSpecFromPath(path);
    if (!existsSync(path)) {
      return { error: `AUTODOC_LLM_E404: model file not found: ${path}` };
    }
    return { spec, weightsPath: path, source: options.operatorModelPath ? "operator-override" : "env-configured" };
  }

  const requested = options.operatorProfile || options.envProfile;
  if (requested) {
    if (requested === "auto") {
      return autoResolve(options.hostCapabilities);
    }
    const profile = requested as ModelProfile;
    if (!MODEL_CATALOG[profile]) {
      return { error: `AUTODOC_LLM_E400: unknown model profile '${requested}' (expected small|mid|large|auto)` };
    }
    const weightsPath = findLocalWeights(MODEL_CATALOG[profile]);
    return { spec: MODEL_CATALOG[profile], weightsPath, source: "operator-override", overrideValue: requested };
  }

  return autoResolve(options.hostCapabilities);
}

function autoResolve(caps: HostCapabilities): ResolvedModel | { error: string } {
  // Largest profile whose weights exist locally and fit the budget.
  for (const profile of [...PROFILE_ORDER].reverse()) {
    const spec = MODEL_CATALOG[profile];
    const neededBytes = spec.totalBudgetGb * 1024 ** 3;
    const fits = caps.effectiveBudgetBytes >= neededBytes * (1 - 0.15);
    const weightsPath = findLocalWeights(spec);
    if (fits && weightsPath) {
      return { spec, weightsPath, source: "auto-selected" };
    }
  }
  // Fall back to any locally available weights (operator pre-downloaded).
  for (const profile of [...PROFILE_ORDER].reverse()) {
    const spec = MODEL_CATALOG[profile];
    const weightsPath = findLocalWeights(spec);
    if (weightsPath) {
      return { spec, weightsPath, source: "auto-selected" };
    }
  }
  return {
    error:
      "AUTODOC_LLM_E404: no local GGUF weights found for any profile and none fits the host budget. " +
      "Provide AUTODOC_LLM_MODEL=<path-to-gguf> or download a model (see docs/llm.md). " +
      "Falling back to deterministic (regex-only) behavior.",
  };
}

function guessSpecFromPath(path: string): ModelSpec {
  const lower = path.toLowerCase();
  if (lower.includes("7b")) return MODEL_CATALOG.large;
  if (lower.includes("4b")) return MODEL_CATALOG.mid;
  return MODEL_CATALOG.small;
}

/** Searches conventional local model directories for a profile's GGUF. */
export function findLocalWeights(spec: ModelSpec): string | undefined {
  const searchDirs = [
    process.env.AUTODOC_LLM_MODELS_DIR,
    join(process.cwd(), ".autodoc", "models"),
    join(process.env.HOME || process.env.USERPROFILE || ".", ".autodoc", "models"),
    process.env.HF_HOME ? join(process.env.HF_HOME, "hub") : undefined,
  ].filter((d): d is string => Boolean(d));

  const pattern = new RegExp(spec.filePattern.replace(/\*/g, ".*"), "i");
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && statSync(full).isDirectory()) {
          // Model repos are often downloaded as directories containing shards.
          const inner = readdirSync(full);
          const shard = inner.find((f) => pattern.test(f) && f.toLowerCase().endsWith(".gguf"));
          if (shard) return join(full, shard);
        } else if (entry.isFile() && pattern.test(entry.name)) {
          return full;
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return undefined;
}