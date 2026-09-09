/**
 * Local LLM provider factory for AutoDoc.
 *
 * Two adapters:
 * - NodeLlamaCppProvider: in-process GGUF inference via the optional
 *   `node-llama-cpp` dependency (lazy import — never a hard dependency).
 * - LlamaServerProvider: HTTP client for a `llama-server` (llama.cpp)
 *   OpenAI-compatible endpoint at AUTODOC_LLM_SERVER_URL.
 *
 * Both are optional at runtime: `createLlmProvider` returns null when the
 * requested adapter cannot be used and callers fall back deterministically.
 */

import type { HostCapabilities } from "./hardware.js";
import { resolveModel, type LlmProvider, type ResolvedModel } from "./provider.js";

export interface LlmConfig {
  /** Adapter preference: in-process (default) or external llama-server. */
  adapter?: "node-llama-cpp" | "llama-server";
  /** Operator model profile override: small|mid|large|auto. */
  profile?: string;
  /** Operator explicit GGUF path override. */
  modelPath?: string;
  serverUrl?: string;
  contextTokens?: number;
}

const LLM_TIMEOUT_MS = Number(process.env.AUTODOC_LLM_TIMEOUT_MS || 120_000);

export async function createLlmProvider(
  caps: HostCapabilities,
  config: LlmConfig = {}
): Promise<LlmProvider | null> {
  const resolved = resolveModel({
    hostCapabilities: caps,
    operatorProfile: config.profile ?? process.env.AUTODOC_LLM_PROFILE,
    operatorModelPath: config.modelPath,
    envModelPath: process.env.AUTODOC_LLM_MODEL,
    envProfile: process.env.AUTODOC_LLM_PROFILE,
  });
  if ("error" in resolved) return null;
  return resolved.weightsPath === undefined && config.adapter !== "llama-server"
    ? null
    : config.adapter === "llama-server" || process.env.AUTODOC_LLM_SERVER_URL
      ? await createLlamaServerProvider(resolved, config)
      : await createNodeLlamaProvider(resolved, config);
}

async function createNodeLlamaProvider(resolved: ResolvedModel, config: LlmConfig): Promise<LlmProvider | null> {
  if (!resolved.weightsPath) return null;
  try {
    // Optional peer dependency: loaded lazily via a dynamic import so the
    // module is never required at startup (the catch handles absence — it is
    // an expected condition, not an error).
    let mod: any = null;
    try {
      mod = await import("node-llama-cpp");
    } catch {
      return null;
    }
    if (!mod) return null;
    const { getLlama, LlamaChatSession } = mod;

    // GPU build environment: make CUDA toolchain visible and work around
    // nvcc/gcc version mismatches without requiring root. Vulkan builds
    // additionally need SPIRV-Headers discoverable via CMAKE_PREFIX_PATH.
    // These are set on process.env because compileLLamaCpp defaults its env
    // to the parent process environment.
    if (process.env.CUDA_PATH && !process.env.PATH?.includes(`${process.env.CUDA_PATH}/bin`)) {
      process.env.PATH = `${process.env.CUDA_PATH}/bin:${process.env.PATH ?? ""}`;
    }
    if (process.env.AUTODOC_CUDA_ALLOW_UNSUPPORTED_COMPILER === "1") {
      process.env.NODE_LLAMA_CPP_CMAKE_OPTION_CMAKE_CUDA_FLAGS = "--allow-unsupported-compiler";
    }

    const llama = await getLlama({
      gpu: "auto",
      build: "auto",
    });
    const contextTokens = config.contextTokens ?? Math.min(resolved.spec.contextTokens, 16384);
    const model = await llama.loadModel({ modelPath: resolved.weightsPath });
    const context = await model.createContext({ contextSize: contextTokens });
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });

    return {
      kind: "node-llama-cpp",
      model: {
        profile: resolved.spec.profile,
        modelId: resolved.spec.modelId,
        contextTokens,
        device: llama.gpu ? String(llama.gpu) : "cpu",
      },
      async isAvailable() {
        return true;
      },
      async complete(prompt, system, options) {
        const response = await session.prompt(prompt, {
          systemPrompt: system,
          maxTokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0,
          // Pathological prompts must not wedge the cached singleton session.
          signal: options?.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
        return String(response);
      },
      async dispose() {
        try {
          await (context as any).dispose?.();
          await (model as any).dispose?.();
        } catch {
          // best-effort release
        }
      },
    };
  } catch {
    return null;
  }
}

async function createLlamaServerProvider(resolved: ResolvedModel, config: LlmConfig): Promise<LlmProvider | null> {
  const url = config.serverUrl || process.env.AUTODOC_LLM_SERVER_URL;
  if (!url) return null;

  return {
    kind: "llama-server",
    model: {
      profile: resolved.spec.profile,
      modelId: resolved.spec.modelId,
      contextTokens: config.contextTokens ?? Math.min(resolved.spec.contextTokens, 16384),
      device: "external-server",
    },
    async isAvailable() {
      try {
        const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    async complete(prompt, system, options) {
      const res = await fetch(new URL("/v1/chat/completions", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: resolved.spec.modelId,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          max_tokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0,
        }),
        signal: options?.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content ?? "";
    },
    async dispose() {
      // External process: nothing to release.
    },
  };
}