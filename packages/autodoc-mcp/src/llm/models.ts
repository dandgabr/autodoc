/**
 * Local LLM model catalog for AutoDoc enrichment.
 *
 * Three hardware profiles within the 5 GB operator budget, all Q4_K_M
 * quantized GGUF. Selection is automatic by available memory with
 * operator override.
 */

export type ModelProfile = "small" | "mid" | "large";

export interface ModelSpec {
  profile: ModelProfile;
  modelId: string;
  quantization: "Q4_K_M";
  weightsGb: number;
  totalBudgetGb: number;
  contextTokens: number;
  license: string;
  description: string;
  /** HuggingFace repo for on-demand GGUF download. */
  downloadRepo: string;
  /** Filename pattern within the repo. */
  filePattern: string;
}

export const MODEL_CATALOG: Record<ModelProfile, ModelSpec> = {
  small: {
    profile: "small",
    modelId: "Qwen2.5-Coder-3B-Instruct",
    quantization: "Q4_K_M",
    weightsGb: 2.0,
    totalBudgetGb: 3.0,
    contextTokens: 32768,
    license: "Apache-2.0",
    description: "Default profile. Best code/JSON quality per GB; fits modest CPU/RAM hosts.",
    downloadRepo: "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF",
    filePattern: "qwen2.5-coder-3b-instruct-q4_k_m*.gguf",
  },
  mid: {
    profile: "mid",
    modelId: "gemma-3-4b-it",
    quantization: "Q4_K_M",
    weightsGb: 2.6,
    totalBudgetGb: 4.0,
    contextTokens: 131072,
    license: "gemma-terms-of-use",
    description: "128k native context for large source files; stronger prose for docs/ADRs.",
    downloadRepo: "ggml-org/gemma-3-4b-it-GGUF",
    filePattern: "gemma-3-4b-it-Q4_K_M*.gguf",
  },
  large: {
    profile: "large",
    modelId: "Qwen2.5-Coder-7B-Instruct",
    quantization: "Q4_K_M",
    weightsGb: 4.68,
    totalBudgetGb: 5.5,
    contextTokens: 32768,
    license: "Apache-2.0",
    description: "Highest code quality within budget; requires ~5.5 GB total memory.",
    downloadRepo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
    filePattern: "qwen2.5-coder-7b-instruct-q4_k_m*.gguf",
  },
};

export const PROFILE_ORDER: ModelProfile[] = ["small", "mid", "large"];

export function getProfile(profile: ModelProfile): ModelSpec {
  return MODEL_CATALOG[profile];
}

/** Memory budget margin required before selecting a profile automatically. */
export const SELECTION_SAFETY_MARGIN = 0.15;