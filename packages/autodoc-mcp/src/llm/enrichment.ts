/**
 * Session-scoped LLM enrichment facade for AutoDoc.
 *
 * Central entrypoint used by analyzers/generators: resolves the model
 * (operator override or auto by hardware), creates the provider lazily,
 * and degrades to null (deterministic behavior) on any failure.
 */

import { detectHostCapabilities, classifyProfile, type HostCapabilities } from "./hardware.js";
import { createLlmProvider, type LlmConfig } from "./factory.js";
import type { LlmProvider } from "./provider.js";
import type { ModelProfile } from "./models.js";

export interface LlmEnrichment {
  provider: LlmProvider;
  selectedProfile: ModelProfile;
  selectionReason: string;
  capabilities: HostCapabilities;
}

let cached: LlmEnrichment | null = null;
let unavailable = false;

export async function getLlmEnrichment(config: LlmConfig = {}): Promise<LlmEnrichment | null> {
  if (unavailable) return null;
  if (cached) return cached;

  try {
    const caps = await detectHostCapabilities();
    const provider = await createLlmProvider(caps, config);
    if (!provider || !(await provider.isAvailable())) {
      unavailable = true;
      return null;
    }
    cached = {
      provider,
      selectedProfile: provider.model.profile,
      selectionReason: config.profile ? `operator override: ${config.profile}` : "auto-selected by host memory budget",
      capabilities: caps,
    };
    return cached;
  } catch {
    unavailable = true;
    return null;
  }
}

export function resetLlmEnrichment(): void {
  cached = null;
  unavailable = false;
}

/** Preview of which profile auto-selection would pick (no model load). */
export function previewAutoProfile(caps: HostCapabilities): ModelProfile | null {
  return classifyProfile(caps);
}

export type { ModelProfile } from "./models.js";
export type { HostCapabilities } from "./hardware.js";
export type { LlmProvider } from "./provider.js";