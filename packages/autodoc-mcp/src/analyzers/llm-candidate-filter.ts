/**
 * Two-pass LLM enrichment for analyzer candidates.
 *
 * Pass 1 (regex/AST) is always executed and remains the source of truth.
 * Pass 2 sends only ambiguous candidates to the local LLM for
 * classification/extraction. Any failure degrades to pass-1-only results
 * with an explicit `llmEnriched: false` flag.
 */

import { getLlmEnrichment } from "../llm/enrichment.js";
import { generateJson } from "../llm/structured.js";
import { z } from "zod";

export interface EnrichmentVerdict<T = Record<string, unknown>> {
  accepted: boolean;
  confidence: number;
  corrections?: T;
  reason?: string;
}

export interface EnrichmentReport {
  llmEnriched: boolean;
  model?: { profile: string; modelId: string };
  candidatesReviewed: number;
  candidatesRejected: number;
  correctionsApplied: number;
}

const VerdictSchema = z.object({
  accepted: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300).optional(),
});

export class LlmCandidateFilter {
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * Validates ambiguous candidates in batch. Returns (verdicts aligned with
   * input order) plus a report. When the LLM is unavailable every candidate
   * is accepted (pass-1 wins) and llmEnriched=false.
   */
  public async validateCandidates(
    candidates: Array<{ label: string; context: string }>
  ): Promise<{ verdicts: EnrichmentVerdict[]; report: EnrichmentReport }> {
    if (!this.enabled || candidates.length === 0) {
      return {
        verdicts: candidates.map(() => ({ accepted: true, confidence: 0 })),
        report: { llmEnriched: false, candidatesReviewed: 0, candidatesRejected: 0, correctionsApplied: 0 },
      };
    }

    const enrichment = await getLlmEnrichment();
    if (!enrichment) {
      return {
        verdicts: candidates.map(() => ({ accepted: true, confidence: 0 })),
        report: { llmEnriched: false, candidatesReviewed: candidates.length, candidatesRejected: 0, correctionsApplied: 0 },
      };
    }

    const verdicts: EnrichmentVerdict[] = [];
    let rejected = 0;

    for (const candidate of candidates) {
      const result = await generateJson(
        enrichment.provider,
        `Analyze this static-analysis candidate from source code and decide whether it is a genuine API/database/realtime contract element or a false positive.\n\nCandidate: ${candidate.label}\nSource context:\n${candidate.context}`,
        "You are a code contract auditor. Be conservative: reject candidates that look like tests, comments, fixtures, or unrelated identifiers.",
        VerdictSchema,
        { maxTokens: 200 }
      );
      if (result.value) {
        verdicts.push(result.value);
        if (!result.value.accepted) rejected++;
      } else {
        // Unparseable → keep pass-1 result (never drop on LLM failure).
        verdicts.push({ accepted: true, confidence: 0, reason: "llm-unparseable" });
      }
    }

    return {
      verdicts,
      report: {
        llmEnriched: true,
        model: {
          profile: enrichment.provider.model.profile,
          modelId: enrichment.provider.model.modelId,
        },
        candidatesReviewed: candidates.length,
        candidatesRejected: rejected,
        correctionsApplied: verdicts.filter((v) => v.corrections).length,
      },
    };
  }
}