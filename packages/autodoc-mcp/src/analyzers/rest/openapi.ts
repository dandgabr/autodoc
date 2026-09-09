/**
 * OpenAPI 3.1 compiler for discovered REST operations.
 *
 * Combines RestAnalyzer endpoint discovery, operation-level contract
 * extraction (parameters / request bodies / responses) and SchemaAnalyzer
 * data models into a single self-consistent OpenAPI 3.1 document with
 * `#/components/schemas` $refs.
 */

import { join, resolve, sep } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { RestAnalyzer } from "./index.js";
import { SchemaAnalyzer, type DataModelContract } from "../schema/index.js";
import { getLlmEnrichment, sanitizeForPrompt } from "../../llm/enrichment.js";
import { generateJson } from "../../llm/structured.js";
import {
  extractPathParams,
  extractHandlerParams,
  extractRequestBody,
  extractResponses,
  extractSecuritySchemes,
  type ApiOperationContract,
  type OperationParameter,
  type OperationBodySchema,
  type OperationResponse,
} from "./operations.js";

export interface OpenApiGeneratorOptions {
  includeTests?: boolean;
  title?: string;
  version?: string;
  serverUrl?: string;
  /** Enable LLM enrichment of descriptions and schema inference (default off). */
  llmEnrichment?: boolean;
  /** Operator model profile: small|mid|large|auto. */
  modelProfile?: string;
}

export interface OpenApiExportResult {
  document: Record<string, unknown>;
  operationsCompiled: number;
  schemasEmitted: number;
  writtenTo?: string;
}

const FRAMEWORK_BY_EXT: Record<string, "node" | "python" | "go" | "rust" | "jvm" | "dotnet" | "php" | "ruby"> = {
  ".ts": "node",
  ".tsx": "node",
  ".js": "node",
  ".jsx": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "jvm",
  ".kt": "jvm",
  ".cs": "dotnet",
  ".php": "php",
  ".rb": "ruby",
};

export class OpenApiGenerator {
  private repoPath: string;
  private options: OpenApiGeneratorOptions;
  /** Cached compiled document for the LLM enrichment pass. */
  private compiledDocument: Record<string, unknown> | null = null;

  constructor(repoPath: string, options: OpenApiGeneratorOptions = {}) {
    this.repoPath = repoPath;
    this.options = options;
  }

  public compile(): OpenApiExportResult {
    const includeTests = this.options.includeTests ?? false;
    const restAnalyzer = new RestAnalyzer(this.repoPath, { includeTests });
    const endpoints = restAnalyzer.discoverEndpoints("REST", 1000, includeTests);

    const schemaAnalyzer = new SchemaAnalyzer(this.repoPath, { includeTests });
    const models = schemaAnalyzer.discoverModels(300, false, includeTests);

    const operations = this.buildOperations(endpoints);
    const { schemas, schemaNames } = this.buildComponentSchemas(models, operations);

    const document = this.compileDocument(operations, schemas, schemaNames);
    this.compiledDocument = document;

    return {
      document,
      operationsCompiled: operations.length,
      schemasEmitted: Object.keys(schemas).length,
    };
  }

  /**
   * LLM pass: adds human descriptions to operations and refines schema
   * summaries from handler evidence. Deterministic structure is untouched —
   * paths, methods, params and $refs come from static analysis only.
   */
  public async enrichDescriptions(): Promise<{ enrichedOperations: number; model?: { profile: string; modelId: string }; llmEnriched: boolean }> {
    if (!this.options.llmEnrichment) return { enrichedOperations: 0, llmEnriched: false };
    const enrichment = await getLlmEnrichment({ profile: this.options.modelProfile });
    if (!enrichment) return { enrichedOperations: 0, llmEnriched: false };

    const DescriptionSchema = z.object({
      summary: z.string().max(120),
      description: z.string().max(500),
    });

    let enriched = 0;
    const document = this.compiledDocument;
    if (!document) return { enrichedOperations: 0, llmEnriched: true, model: enrichment.provider.model };

    const paths = document.paths as Record<string, Record<string, any>>;
    for (const [path, item] of Object.entries(paths)) {
      for (const op of Object.values(item)) {
        const evidence = sanitizeForPrompt(op?.["x-source-file"] ? `source: ${op["x-source-file"]}` : "", "openapi_evidence");
        const result = await generateJson(
          enrichment.provider,
          `Write a concise OpenAPI summary and description for this API operation.\nOperation: ${op?.summary ?? path}\nEvidence: ${evidence}`,
          "You are an API documentation writer. Base every claim on the provided evidence; never invent behavior.",
          DescriptionSchema,
          { maxTokens: 250 }
        );
        if (result.value) {
          op.summary = result.value.summary;
          op.description = result.value.description;
          enriched++;
        }
      }
    }

    return { enrichedOperations: enriched, llmEnriched: true, model: enrichment.provider.model };
  }

  public exportToDirectory(outputDir: string, filename: string = "openapi.json"): OpenApiExportResult {
    const result = this.compile();
    mkdirSync(outputDir, { recursive: true });
    const target = join(outputDir, filename);
    writeFileSync(target, JSON.stringify(result.document, null, 2), "utf-8");
    return { ...result, writtenTo: target };
  }

  private buildOperations(endpoints: ReturnType<RestAnalyzer["discoverEndpoints"]>): ApiOperationContract[] {
    const operations: ApiOperationContract[] = [];
    const seen = new Map<string, ApiOperationContract>();
    // Cache file reads: multiple endpoints in the same source file share one
    // readFileSync (routes files commonly hold 10-50 endpoints).
    const fileBodyCache = new Map<string, string | undefined>();
    let requestBodyOverride: ApiOperationContract["requestBody"];

    for (const ep of endpoints) {
      const method = ep.method.toUpperCase();
      if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) continue;

      const framework = FRAMEWORK_BY_EXT[extOf(ep.sourceFile)] || "node";
      const fileBodyOnce = () => {
        const key = ep.sourceFile ?? "";
        if (!fileBodyCache.has(key)) fileBodyCache.set(key, readHandlerBody(this.repoPath, ep.sourceFile));
        return fileBodyCache.get(key);
      };
      const handlerBody = extractHandlerWindow(fileBodyOnce(), ep.endpoint, ep.method);

      const pathParams = extractPathParams(ep.endpoint);
      const handlerParams = handlerBody ? extractHandlerParams(handlerBody, framework) : [];
      const parameters = mergeParams(pathParams, handlerParams);

      const requestBody = handlerBody ? extractRequestBody(handlerBody, method, framework) : undefined;
      // Fallback: the window may only see `const { a, b } = req.body` while the
      // validator (e.g. Zod) is declared at file scope — prefer the richer
      // file-level schema when it fully covers the window's destructure.
      const fileBody = fileBodyOnce();
      if (fileBody && handlerBody !== fileBody) {
        const fileLevelBody = extractRequestBody(fileBody, method, framework);
        if (fileLevelBody && isRicherSchema(fileLevelBody, requestBody)) {
          requestBodyOverride = fileLevelBody;
        }
      }
      const responses = handlerBody ? extractResponses(handlerBody, framework) : [{ statusCode: "200", description: "OK" }];
      const security = extractSecuritySchemes(handlerBody || "", [
        ep.sourceFile || "",
        ep.handler || "",
        ep.auth || "",
      ].join(" "));

      const op: ApiOperationContract = {
        endpoint: normalizePath(ep.endpoint),
        method,
        parameters,
        requestBody: requestBodyOverride ?? requestBody,
        responses,
        security: security.includes("none") ? [] : security,
        tags: deriveTags(ep.endpoint),
        sourceFile: ep.sourceFile,
        handler: ep.handler,
      };

      const key = `${method} ${op.endpoint}`;
      const existing = seen.get(key);
      if (existing) {
        mergeOperation(existing, op);
      } else {
        seen.set(key, op);
        operations.push(op);
      }
      requestBodyOverride = undefined;
    }

    return operations;
  }

  private buildComponentSchemas(
    models: DataModelContract[],
    operations: ApiOperationContract[]
  ): { schemas: Record<string, Record<string, unknown>>; schemaNames: Set<string> } {
    const schemas: Record<string, Record<string, unknown>> = {};
    const schemaNames = new Set<string>();

    for (const model of models) {
      if (model.isSubdocument) continue;
      const name = toSchemaName(model.modelName);
      if (schemas[name]) continue;
      schemaNames.add(name);

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const field of model.fields) {
        const prop = fieldToSchemaProp(field, schemaNames);
        properties[field.name] = prop;
        if (field.required) required.push(field.name);
      }
      schemas[name] = {
        type: "object",
        description: `${model.framework} model mapped from ${model.sourceFile}`,
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    // Ensure every $ref used by operations has a component (stub when unresolved).
    for (const op of operations) {
      for (const usedRef of collectRefs(op)) {
        const name = toSchemaName(usedRef);
        if (!schemas[name]) {
          schemas[name] = {
            type: "object",
            description: `Inferred from handler usage in ${op.sourceFile || "unknown"} (shape not statically resolvable).`,
          };
        }
      }
    }

    return { schemas, schemaNames };
  }

  private compileDocument(
    operations: ApiOperationContract[],
    schemas: Record<string, Record<string, unknown>>,
    schemaNames: Set<string>
  ): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};

    for (const op of operations) {
      const pathItem = (paths[op.endpoint] ||= {});
      pathItem[op.method.toLowerCase()] = this.compileOperation(op, schemaNames);
    }

    const securitySchemes: Record<string, unknown> = {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
      basicAuth: { type: "http", scheme: "basic" },
      oauth2: {
        type: "oauth2",
        flows: { authorizationCode: { authorizationUrl: "/", tokenUrl: "/", scopes: {} } },
      },
    };

    return {
      openapi: "3.1.0",
      info: {
        title: this.options.title || "AutoDoc-generated API Contract",
        version: this.options.version || "1.0.0",
        description:
          "Reverse-engineered OpenAPI contract synthesized by AutoDoc from static source analysis. " +
          "Schemas marked as inferred come from handler usage; shapes were not fully statically resolvable.",
        "x-generator": "autodoc-mcp",
      },
      servers: this.options.serverUrl ? [{ url: this.options.serverUrl }] : [],
      tags: buildTags(operations),
      paths,
      components: { schemas, securitySchemes },
    };
  }

  private compileOperation(
    op: ApiOperationContract,
    schemaNames: Set<string>
  ): Record<string, unknown> {
    const parameters = op.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      schema: { type: p.type },
    }));

    const compiledResponses: Record<string, unknown> = {};
    for (const r of op.responses) {
      compiledResponses[r.statusCode] = {
        description: r.description,
        ...(r.ref && schemaNames.has(toSchemaName(r.ref))
          ? {
              content: {
                "application/json": {
                  schema: isListResponse(r)
                    ? { type: "array", items: { $ref: refFor(r.ref) } }
                    : { $ref: refFor(r.ref) },
                },
              },
            }
          : r.schema && r.schema.type === "object" && (r.schema as OperationBodySchema).properties
            ? {
                content: {
                  "application/json": { schema: compileObjectSchema(r.schema as OperationBodySchema, schemaNames) },
                },
              }
            : {}),
      };
    }

    const compiled: Record<string, unknown> = {
      operationId: buildOperationId(op),
      tags: op.tags,
      summary: `${op.method} ${op.endpoint}`,
      description: op.sourceFile ? `Handler source: \`${op.sourceFile}\`` : undefined,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.requestBody
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: compileObjectSchema(op.requestBody, schemaNames) },
              },
            },
          }
        : {}),
      responses: compiledResponses,
      ...(op.security.length > 0 ? { security: [{ [op.security[0]]: [] }] } : {}),
      "x-source-file": op.sourceFile,
    };

    return compiled;
  }
}

function isListResponse(r: OperationResponse): boolean {
  return (r as { schema?: { type?: string } }).schema?.type === "array";
}

function buildTags(operations: ApiOperationContract[]): Array<{ name: string; description?: string }> {
  const tags = new Set<string>();
  for (const op of operations) for (const t of op.tags) tags.add(t);
  return Array.from(tags).map((name) => ({ name }));
}

function deriveTags(endpoint: string): string[] {
  const segments = endpoint.split("/").filter(Boolean).filter((s) => !s.startsWith(":") && !s.startsWith("{"));
  if (segments.length === 0) return ["root"];
  const meaningful = segments.filter((s) => !["api", "v1", "v2", "v3", "rest"].includes(s.toLowerCase()));
  return [meaningful[0] || segments[0]];
}

function buildOperationId(op: ApiOperationContract): string {
  const parts = op.endpoint
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith(":") || s.startsWith("{") ? "By" + capitalize(s.replace(/[:{}]/g, "")) : s))
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, ""));
  const id = op.method.toLowerCase() + parts.map((p) => capitalize(p)).join("");
  return id.slice(0, 120) || `${op.method.toLowerCase()}Root`;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function normalizePath(endpoint: string): string {
  return endpoint.replace(/\{([a-zA-Z0-9_]+)\}/g, "{$1}").replace(/:([a-zA-Z0-9_]+)/g, "{$1}") || "/";
}

function mergeParams(
  pathParams: OperationParameter[],
  handlerParams: OperationParameter[]
): OperationParameter[] {
  const merged: Map<string, OperationParameter> = new Map();
  for (const p of [...pathParams, ...handlerParams]) {
    const existing = merged.get(p.name);
    if (!existing) {
      merged.set(p.name, p);
    } else if (existing.in !== "path" && p.in === "path") {
      merged.set(p.name, p);
    }
  }
  return Array.from(merged.values()).slice(0, 30);
}

function mergeOperation(target: ApiOperationContract, incoming: ApiOperationContract): void {
  const merged = new Map(target.responses.map((r) => [r.statusCode, r]));
  for (const r of incoming.responses) {
    if (!merged.has(r.statusCode)) merged.set(r.statusCode, r);
  }
  target.responses = Array.from(merged.values());
  if (!target.requestBody && incoming.requestBody) target.requestBody = incoming.requestBody;
}

function fieldToSchemaProp(
  field: { name: string; type: string; ref?: string },
  schemaNames: Set<string>
): Record<string, unknown> {
  const raw = field.type || "String";
  const lower = raw.toLowerCase();

  if (field.ref && schemaNames.has(toSchemaName(field.ref))) {
    return { $ref: refFor(field.ref) };
  }

  if (lower.includes("objectid") || lower.includes("uuid")) return { type: "string", format: "uuid" };
  if (lower.includes("date")) return { type: "string", format: "date-time" };
  if (lower.includes("number") || lower.includes("float") || lower.includes("double") || lower.includes("decimal")) {
    return { type: "number" };
  }
  if (lower.includes("int") || lower.includes("long") || lower.includes("integer")) return { type: "integer" };
  if (lower.includes("bool")) return { type: "boolean" };
  if (lower.includes("[") || lower.includes("array")) return { type: "array", items: { type: "string" } };
  if (raw === "Mixed" || raw === "Map") return { type: "object" };
  if (raw === "Buffer" || raw === "Binary") return { type: "string", format: "byte" };
  return { type: "string" };
}

function compileObjectSchema(
  body: OperationBodySchema,
  schemaNames: Set<string>
): Record<string, unknown> {
  if (body.ref && schemaNames.has(toSchemaName(body.ref))) {
    return { $ref: refFor(body.ref) };
  }
  const properties: Record<string, unknown> = {};
  for (const prop of body.properties) {
    const schema: Record<string, unknown> = { type: prop.type };
    if (prop.format) schema.format = prop.format;
    if (prop.itemsType) schema.items = { type: prop.itemsType };
    if (prop.enumValues) schema.enum = prop.enumValues;
    if (prop.ref && schemaNames.has(toSchemaName(prop.ref))) {
      properties[prop.name] = { $ref: refFor(prop.ref) };
      continue;
    }
    properties[prop.name] = schema;
  }
  return {
    type: "object",
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(body.required.length > 0 ? { required: body.required } : {}),
  };
}

function collectRefs(op: ApiOperationContract): string[] {
  const refs: string[] = [];
  if (op.requestBody?.ref) refs.push(op.requestBody.ref);
  for (const r of op.responses) {
    if (r.ref) refs.push(r.ref);
    if (r.schema && r.schema.type === "object" && (r.schema as OperationBodySchema).properties) {
      for (const p of (r.schema as OperationBodySchema).properties) {
        if (p.ref) refs.push(p.ref);
      }
    }
  }
  return refs;
}

function toSchemaName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function refFor(name: string): string {
  return `#/components/schemas/${toSchemaName(name)}`;
}

/**
 * Prefers the schema with the richer evidence: explicit properties beat a
 * bare ref, more properties beat fewer, and optional fields (missing from
 * `required`) beat the all-required destructure fallback.
 */
function isRicherSchema(
  candidate: NonNullable<ApiOperationContract["requestBody"]>,
  current: ApiOperationContract["requestBody"]
): boolean {
  if (!current) return true;
  if (candidate.ref && !candidate.properties.length && current.properties.length > 0) return false;
  if (current.ref && !current.properties.length && candidate.properties.length > 0) return true;
  if (candidate.properties.length !== current.properties.length) {
    return candidate.properties.length > current.properties.length;
  }
  // Same field count: prefer the schema with richer type evidence
  // (formats, enums, optional flags) over the raw destructure fallback.
  const score = (s: NonNullable<ApiOperationContract["requestBody"]>) =>
    s.properties.reduce(
      (acc, p) => acc + (p.format ? 1 : 0) + (p.enumValues ? 1 : 0) + (p.required ? 0 : 1),
      0
    );
  return score(candidate) > score(current);
}

/**
 * Narrows a source file body to the window containing the handler for a
 * specific route (from the route declaration up to the next route
 * declaration), so parameters and responses do not leak across operations.
 */
function extractHandlerWindow(
  fileBody: string | undefined,
  endpoint: string,
  method: string
): string | undefined {
  if (!fileBody) return undefined;
  const rawPath = endpoint
    .replace(/\{([a-zA-Z0-9_]+)\}/g, ":$1")
    .replace(/\/+$/, "") || "/";
  const escaped = rawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRegex = new RegExp(
    `(?:router|app|fastify|server|@(?:Get|Post|Put|Delete|Patch))\\s*\\.?\\s*\\(?\\s*${method.toLowerCase()}|${method.toLowerCase()}\\s*\\(\\s*['"\`]?${escaped}\\b|\\.route\\s*\\(\\s*['"\`]${escaped}`,
    "i"
  );
  const startMatch = declRegex.exec(fileBody);
  if (!startMatch) return fileBody;
  const start = startMatch.index;
  const nextDecl = /(?:router|app|fastify|server)\s*\.\s*(?:get|post|put|delete|patch|route)\s*\(|@(?:Get|Post|Put|Delete|Patch)\s*\(/gi;
  nextDecl.lastIndex = start + 10;
  const nextMatch = nextDecl.exec(fileBody);
  return fileBody.slice(start, nextMatch ? nextMatch.index : undefined);
}

function readHandlerBody(repoPath: string, sourceFile?: string): string | undefined {
  if (!sourceFile) return undefined;
  try {
    const resolved = resolve(join(repoPath, sourceFile));
    // Defensive containment: sourceFile comes from the analyzer's own walk,
    // but if it ever carried an absolute or traversing path the read would
    // escape the target repository.
    if (!resolved.startsWith(resolve(repoPath) + sep) && resolved !== resolve(repoPath)) return undefined;
    return readFileSync(resolved, "utf-8");
  } catch {
    return undefined;
  }
}

function extOf(sourceFile?: string): string {
  if (!sourceFile) return "";
  const idx = sourceFile.lastIndexOf(".");
  return idx === -1 ? "" : sourceFile.slice(idx);
}