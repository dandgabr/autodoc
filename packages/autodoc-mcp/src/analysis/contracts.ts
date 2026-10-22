import { z } from 'zod';

const NullableLine = z.number().int().positive().nullable().optional();

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  lineStart: NullableLine,
  lineEnd: NullableLine,
  extractor: z.string().min(1),
  method: z.enum(['inventory', 'ast', 'tree_sitter_ast', 'config', 'heuristic', 'llm']),
}).strict().superRefine((value, context) => {
  if (value.lineStart != null && value.lineEnd != null && value.lineEnd < value.lineStart) {
    context.addIssue({ code: 'custom', message: 'lineEnd must be greater than or equal to lineStart', path: ['lineEnd'] });
  }
  if ((value.method === 'ast' || value.method === 'tree_sitter_ast') && !value.contentSha256) {
    context.addIssue({ code: 'custom', message: 'AST evidence requires a content SHA-256', path: ['contentSha256'] });
  }
});

export const CoverageSchema = z.object({
  state: z.enum(['complete', 'partial', 'not_scanned', 'unsupported']),
  examined: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  diagnostics: z.array(z.object({ code: z.string().min(1), path: z.string().nullable().optional() }).strict()),
}).strict();

export const InventoryFileSchema = z.object({
  path: z.string().min(1),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  category: z.enum(['source', 'markup', 'style', 'manifest', 'infra', 'docs', 'asset', 'other']),
  support: z.enum(['ast', 'heuristic', 'metadata', 'unsupported']),
  excludedReason: z.string().nullable().optional(),
  readError: z.string().nullable().optional(),
}).strict();

export const FactSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  attributes: z.record(z.string(), z.unknown()),
}).strict();

export const RelationSchema = z.object({
  id: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1).nullable().optional(),
  kind: z.string().min(1),
  resolution: z.enum(['resolved', 'ambiguous', 'unresolved']),
  candidateIds: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
}).strict();

const SnapshotEnvelope = {
  contractVersion: z.literal(2),
  schemaVersion: z.literal(5),
  scanId: z.string().min(1),
  repositoryRoot: z.string().min(1),
};

export const SnapshotMetadataSchema = z.object({
  ...SnapshotEnvelope,
  createdAt: z.string().datetime(),
  extractorVersions: z.record(z.string(), z.string()),
  coverage: z.record(z.string(), CoverageSchema),
  latestAttempt: z.object({
    scanId: z.string().min(1),
    state: z.enum(['running', 'complete', 'partial', 'failed', 'superseded']),
  }).strict().nullable(),
  freshness: z.enum(['verified', 'unchecked', 'stale']),
  totals: z.object({
    facts: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const SnapshotPageBase = {
  ...SnapshotEnvelope,
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  coverage: CoverageSchema,
};

export const SnapshotPageSchema = z.discriminatedUnion('collection', [
  z.object({ ...SnapshotPageBase, collection: z.literal('facts'), items: z.array(FactSchema) }).strict(),
  z.object({ ...SnapshotPageBase, collection: z.literal('evidence'), items: z.array(EvidenceSchema) }).strict(),
  z.object({ ...SnapshotPageBase, collection: z.literal('relations'), items: z.array(RelationSchema) }).strict(),
  z.object({ ...SnapshotPageBase, collection: z.literal('files'), items: z.array(InventoryFileSchema) }).strict(),
]);

export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;
export type SnapshotPage = z.infer<typeof SnapshotPageSchema>;
export type InventoryFile = z.infer<typeof InventoryFileSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Relation = z.infer<typeof RelationSchema>;

export function parseSnapshotMetadata(input: unknown): SnapshotMetadata {
  return SnapshotMetadataSchema.parse(input);
}

export function parseSnapshotPage(
  input: unknown,
  expected?: { scanId: string; repositoryRoot: string; collection: SnapshotPage['collection'] },
): SnapshotPage {
  const page = SnapshotPageSchema.parse(input);
  if (expected && (page.scanId !== expected.scanId || page.repositoryRoot !== expected.repositoryRoot || page.collection !== expected.collection)) {
    throw new Error('Snapshot page does not match its pinned scan, repository root, or collection');
  }
  return page;
}
