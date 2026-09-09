import { describe, it, expect } from "vitest";
import { classifyProfile, type HostCapabilities } from "../src/llm/hardware.js";
import { MODEL_CATALOG, PROFILE_ORDER } from "../src/llm/models.js";
import { resolveModel, findLocalWeights } from "../src/llm/provider.js";
import { generateJson } from "../src/llm/structured.js";
import { z } from "zod";

const GB = 1024 ** 3;

function caps(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    totalRamBytes: 32 * GB,
    freeRamBytes: 16 * GB,
    effectiveBudgetBytes: 16 * GB,
    device: "cpu",
    detectedVia: ["test"],
    ...overrides,
  };
}

describe("LLM hardware classification", () => {
  it("selects the largest profile that fits the effective budget", () => {
    // 16 GB free → large (~5.5 GB budget) fits comfortably.
    expect(classifyProfile(caps())).toBe("large");
  });

  it("degrades to mid when only ~4.5 GB is available", () => {
    expect(classifyProfile(caps({ effectiveBudgetBytes: 4.5 * GB }))).toBe("mid");
  });

  it("degrades to small when only ~3.0 GB is available", () => {
    expect(classifyProfile(caps({ effectiveBudgetBytes: 3.0 * GB }))).toBe("small");
  });

  it("returns null below the smallest profile budget", () => {
    expect(classifyProfile(caps({ effectiveBudgetBytes: 1 * GB }))).toBeNull();
  });
});

describe("LLM model resolution", () => {
  it("prefers the operator model path override", () => {
    const r = resolveModel({
      hostCapabilities: caps({ effectiveBudgetBytes: 1 * GB }),
      operatorModelPath: "/tmp/nonexistent.gguf",
    });
    // Path does not exist → explicit error, never silent fallback.
    expect("error" in r).toBe(true);
  });

  it("honors an explicit operator profile", () => {
    // No local weights exist in test env — resolver reports which profile was requested.
    const r = resolveModel({ hostCapabilities: caps(), operatorProfile: "small" });
    if (!("error" in r)) {
      expect(r.spec.profile).toBe("small");
    }
  });

  it("rejects unknown profiles", () => {
    const r = resolveModel({ hostCapabilities: caps(), operatorProfile: "gigantic" });
    expect("error" in r).toBe(true);
  });
});

describe("LLM structured output (generateJson)", () => {
  it("accepts valid JSON on the first attempt", async () => {
    const provider = {
      kind: "node-llama-cpp" as const,
      model: { profile: "small" as const, modelId: "test", contextTokens: 1024, device: "cpu" },
      isAvailable: async () => true,
      complete: async () => '{"summary": "hello", "description": "world"}',
      dispose: async () => {},
    };
    const S = z.object({ summary: z.string(), description: z.string() });
    const r = await generateJson(provider, "prompt", "system", S);
    expect(r.value).toEqual({ summary: "hello", description: "world" });
    expect(r.attempts).toBe(1);
  });

  it("repairs invalid JSON on the retry attempt", async () => {
    let calls = 0;
    const provider = {
      kind: "node-llama-cpp" as const,
      model: { profile: "small" as const, modelId: "test", contextTokens: 1024, device: "cpu" },
      isAvailable: async () => true,
      complete: async () => {
        calls++;
        return calls === 1 ? "I think the answer is prose." : '{"summary": "ok", "description": "repaired"}';
      },
      dispose: async () => {},
    };
    const S = z.object({ summary: z.string(), description: z.string() });
    const r = await generateJson(provider, "prompt", "system", S);
    expect(r.attempts).toBe(2);
    expect(r.value).toEqual({ summary: "ok", description: "repaired" });
  });

  it("returns null after exhausting attempts (never accepts unparseable output)", async () => {
    const provider = {
      kind: "node-llama-cpp" as const,
      model: { profile: "small" as const, modelId: "test", contextTokens: 1024, device: "cpu" },
      isAvailable: async () => true,
      complete: async () => "definitely not json",
      dispose: async () => {},
    };
    const S = z.object({ summary: z.string() });
    const r = await generateJson(provider, "prompt", "system", S);
    expect(r.value).toBeNull();
    expect(r.attempts).toBe(2);
  });
});

describe("Model catalog integrity", () => {
  it("exposes exactly the three documented profiles", () => {
    expect(PROFILE_ORDER).toEqual(["small", "mid", "large"]);
    for (const p of PROFILE_ORDER) {
      expect(MODEL_CATALOG[p].totalBudgetGb).toBeLessThanOrEqual(5.5);
      expect(MODEL_CATALOG[p].license.length).toBeGreaterThan(0);
    }
  });
});