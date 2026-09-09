/**
 * Session-scoped LLM enrichment facade for AutoDoc.
 *
 * Central entrypoint used by analyzers/generators: resolves the model
 * (operator override or auto by hardware), creates the provider lazily,
 * sanitizes every byte of source code before it reaches a model, and
 * degrades to null (deterministic behavior) on any failure.
 */

import { detectHostCapabilities, classifyProfile, type HostCapabilities } from "./hardware.js";
import { createLlmProvider, type LlmConfig } from "./factory.js";
import type { LlmProvider } from "./provider.js";
import type { ModelProfile } from "./models.js";
import { loadNativeBinding } from "../binding.js";

export interface LlmEnrichment {
  provider: LlmProvider;
  selectedProfile: ModelProfile;
  selectionReason: string;
  capabilities: HostCapabilities;
}

let cached: LlmEnrichment | null = null;
let cachedPromise: Promise<LlmEnrichment | null> | null = null;
let unavailable = false;

export async function getLlmEnrichment(config: LlmConfig = {}): Promise<LlmEnrichment | null> {
  if (unavailable) return null;
  if (cached) return cached;
  // Memoize the in-flight promise so concurrent tool calls do not load the
  // model twice (each load allocates GBs of RAM).
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async (): Promise<LlmEnrichment | null> => {
    try {
      const caps = await detectHostCapabilities();
      const provider = await createLlmProvider(caps, config);
      if (!provider || !(await provider.isAvailable())) {
        unavailable = true;
        return null;
      }
      const result: LlmEnrichment = {
        provider,
        selectedProfile: provider.model.profile,
        selectionReason: config.profile ? `operator override: ${config.profile}` : "auto-selected by host memory budget",
        capabilities: caps,
      };
      cached = result;
      return result;
    } catch (err) {
      process.stderr.write(`[autodoc][llm] provider initialization failed: ${err instanceof Error ? err.message : String(err)}\n`);
      unavailable = true;
      return null;
    }
  })();

  const result = await cachedPromise;
  cachedPromise = null;
  return result;
}

export function resetLlmEnrichment(): void {
  cached = null;
  cachedPromise = null;
  unavailable = false;
}

/** Preview of which profile auto-selection would pick (no model load). */
export function previewAutoProfile(caps: HostCapabilities): ModelProfile | null {
  return classifyProfile(caps);
}

/**
 * Sanitizes untrusted source content before it is embedded in any LLM prompt.
 *
 * Uses the Rust PII/secret scrubber when the native binding is available and
 * always wraps the payload in the `<untrusted_code_context>` defense boundary
 * so the model treats it as data, never as instructions. Centralized here so
 * every LLM code path inherits both controls.
 */
export function sanitizeForPrompt(sourceContext: string, origin = "code_scan", file = "unknown"): string {
  if (!sourceContext) return "";
  let clean = sourceContext;
  let redactions = 0;
  try {
    const binding = loadNativeBinding();
    if (typeof binding.sanitizeContent === "function") {
      const result = binding.sanitizeContent(clean);
      clean = result.sanitizedText;
      redactions = result.redactionCount;
    }
  } catch {
    // Native binding unavailable; proceed with the untrusted wrapper only.
  }
  const wrapped = `<untrusted_code_context origin="${origin}" path="${file}">\n${clean}\n</untrusted_code_context>`;
  return redactions > 0 ? `${wrapped}\n[autodoc: ${redactions} secret/PII redaction(s) applied]` : wrapped;
}

export type { ModelProfile } from "./models.js";
export type { HostCapabilities } from "./hardware.js";
export type { LlmProvider } from "./provider.js";