/**
 * Structured-output helper: constrained JSON generation with schema
 * validation and one repair retry. Guarantees either a valid parsed object
 * or null (never invalid JSON silently accepted).
 */

import type { LlmProvider } from "./provider.js";
import type { z } from "zod";

export interface StructuredResult<T> {
  value: T | null;
  attempts: number;
  error?: string;
}

export async function generateJson<T>(
  provider: LlmProvider,
  prompt: string,
  system: string,
  schema: z.ZodType<T>,
  options?: { maxTokens?: number }
): Promise<StructuredResult<T>> {
  const shape = describeSchema(schema);
  const baseSystem = [
    system,
    "You must respond with a single JSON object and nothing else.",
    `The JSON object must have exactly these keys: ${shape}.`,
    "Do not add markdown, code fences, explanations, or examples around the JSON.",
    "Do not invent fields that are not in the evidence; if evidence is missing, use an empty string.",
  ].join("\n");

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptPrompt = attempt === 1 ? prompt : `${prompt}\n\nIMPORTANT: Your previous answer was not valid JSON matching the required keys. Respond ONLY with the JSON object: ${shape}`;
    try {
      const raw = await provider.complete(attemptPrompt, baseSystem, {
        maxTokens: options?.maxTokens,
        temperature: 0,
      });
      const jsonText = extractJsonBlock(raw);
      const parsed = schema.safeParse(JSON.parse(jsonText));
      if (parsed.success) {
        return { value: parsed.data, attempts: attempt };
      }
      lastError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300);
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    }
  }
  return { value: null as T, attempts: 2, error: lastError };
}

/** Pulls the first JSON object out of a possibly chatty response. */
function extractJsonBlock(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object in response");
  return candidate.slice(start, end + 1);
}

/** Human-readable key shape for the system prompt (derived from the Zod object). */
function describeSchema(schema: z.ZodType): string {
  try {
    const def = (schema as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def;
    const shape = def?.shape?.();
    const keys = Object.keys(shape || {});
    if (keys.length === 0) return "{}";
    return keys.map((k) => `"${k}"`).join(", ");
  } catch {
    return "{}";
  }
}