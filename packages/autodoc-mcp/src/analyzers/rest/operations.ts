/**
 * Operation contract extraction for REST endpoints.
 *
 * Enriches the flat endpoint inventory produced by RestAnalyzer with
 * parameter expectations, request bodies and response shapes inferred from
 * handler source code, producing per-operation evidence used to compile a
 * complete OpenAPI 3.1 contract.
 */

export interface OperationParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
}

export interface SchemaProperty {
  name: string;
  type: string;
  required: boolean;
  format?: string;
  itemsType?: string;
  enumValues?: string[];
  ref?: string;
}

export interface OperationBodySchema {
  type: "object";
  properties: SchemaProperty[];
  required: string[];
  ref?: string;
}

export interface OperationResponse {
  statusCode: string;
  description: string;
  schema?: OperationBodySchema | { type: "array"; ref: string };
  ref?: string;
}

export interface ApiOperationContract {
  endpoint: string;
  method: string;
  parameters: OperationParameter[];
  requestBody?: OperationBodySchema;
  responses: OperationResponse[];
  security: string[];
  tags: string[];
  sourceFile?: string;
  handler?: string;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const PATH_PARAM_REGEX = /(?::|\{)([a-zA-Z0-9_]+)(?:\}|(?=\/|$))/g;
const STATUS_CODE_REGEX = /(?:res|response|ctx|c)\s*\.\s*status\s*\(\s*(\d{3})|\.\s*sendStatus\s*\(\s*(\d{3})|returning\s*\(\s*(\d{3})|@ResponseStatus\s*\(\s*[A-Za-z.]+\s*(\d{3})/g;
const JSON_BODY_REGEX = /res(?:ponse)?\s*\.\s*json\s*\(\s*\{([^}]*)\}\s*\)/gs;

const TYPE_MAP: Record<string, OperationParameter["type"]> = {
  id: "string",
  string: "string",
  str: "string",
  text: "string",
  email: "string",
  uuid: "string",
  date: "string",
  datetime: "string",
  password: "string",
  token: "string",
  name: "string",
  slug: "string",
  query: "string",
  search: "string",
  sort: "string",
  filter: "string",
  page: "integer",
  limit: "integer",
  offset: "integer",
  count: "integer",
  int: "integer",
  integer: "integer",
  float: "number",
  double: "number",
  number: "number",
  num: "number",
  price: "number",
  amount: "number",
  score: "number",
  boolean: "boolean",
  bool: "boolean",
  is: "boolean",
  has: "boolean",
  enabled: "boolean",
};

export function expectsRequestBody(method: string): boolean {
  return BODY_METHODS.has(method.toUpperCase());
}

/**
 * Extracts path parameter names from a route template supporting Express
 * (`:id`), NestJS, FastAPI (`{id}`), Axum (`:id`), Gin and Spring conventions.
 */
export function extractPathParams(routePath: string): OperationParameter[] {
  const params: OperationParameter[] = [];
  const seen = new Set<string>();
  let match;
  PATH_PARAM_REGEX.lastIndex = 0;
  while ((match = PATH_PARAM_REGEX.exec(routePath)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    params.push({
      name,
      in: "path",
      required: true,
      type: inferParamType(name),
    });
  }
  return params;
}

/**
 * Infers query/header parameter usage inside a handler body: Express
 * `req.query.x` / `req.headers.x`, Fastify `request.query`, FastAPI `Query()`,
 * Gin `c.Query("x")`, Spring `@RequestParam`, .NET `[FromQuery]`, Rails `params`.
 */
export function extractHandlerParams(
  handlerBody: string,
  framework: "node" | "python" | "go" | "rust" | "jvm" | "dotnet" | "php" | "ruby"
): OperationParameter[] {
  const params: Map<string, OperationParameter> = new Map();
  const add = (name: string, loc: OperationParameter["in"], type: OperationParameter["type"] = "string", required = false) => {
    if (!name || name.length > 64) return;
    if (params.has(name)) return;
    params.set(name, { name, in: loc, required, type });
  };

  if (framework === "node") {
    let m;
    const queryRegex = /req(?:uest)?\.(?:query|searchParams(?:\.get)?)\s*[.(]\s*['"`]?([a-zA-Z0-9_.-]+)/g;
    while ((m = queryRegex.exec(handlerBody)) !== null) add(m[1], "query", inferParamType(m[1]));
    const headerRegex = /req(?:uest)?\.headers(?:\.[a-zA-Z]+)?\s*[.[(]\s*['"`]([a-zA-Z0-9_-]+)/g;
    while ((m = headerRegex.exec(handlerBody)) !== null) add(m[1], "header");
    const cookieRegex = /req(?:uest)?\.cookies\.(?:get\(\s*)?['"`]([a-zA-Z0-9_-]+)/g;
    while ((m = cookieRegex.exec(handlerBody)) !== null) add(m[1], "header");
  } else if (framework === "python") {
    let m;
    const fastApiRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[A-Za-z.]+\s*=\s*(?:Query|Header)\s*\(/g;
    while ((m = fastApiRegex.exec(handlerBody)) !== null) {
      add(m[1], m[0].includes("Header") ? "header" : "query", inferParamType(m[1]));
    }
    const flaskRegex = /request\.args\.get\(\s*['"`]([a-zA-Z0-9_-]+)/g;
    while ((m = flaskRegex.exec(handlerBody)) !== null) add(m[1], "query", inferParamType(m[1]));
  } else if (framework === "go") {
    let m;
    const ginRegex = /c\.(?:Query|Param|GetHeader)\(\s*"([a-zA-Z0-9_-]+)/g;
    while ((m = ginRegex.exec(handlerBody)) !== null) {
      const loc = m[0].includes("GetHeader") ? "header" : m[0].includes("Param") ? "path" : "query";
      add(m[1], loc, inferParamType(m[1]));
    }
  } else if (framework === "jvm") {
    let m;
    const springParamRegex = /@RequestParam\s*\(\s*(?:name\s*=\s*)?["']([a-zA-Z0-9_-]+)/g;
    while ((m = springParamRegex.exec(handlerBody)) !== null) add(m[1], "query", inferParamType(m[1]));
    const springHeaderRegex = /@RequestHeader\s*\(\s*(?:name\s*=\s*)?["']([a-zA-Z0-9_-]+)/g;
    while ((m = springHeaderRegex.exec(handlerBody)) !== null) add(m[1], "header");
    const springPathRegex = /@PathVariable\s*\(\s*(?:name\s*=\s*)?["']([a-zA-Z0-9_-]+)/g;
    while ((m = springPathRegex.exec(handlerBody)) !== null) add(m[1], "path", inferParamType(m[1]));
  } else if (framework === "dotnet") {
    let m;
    const fromQueryRegex = /\[FromQuery(?:\(Name\s*=\s*"([^"]+)")?\)\]\s*(?:public\s+)?[A-Za-z[\]<>.]+\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((m = fromQueryRegex.exec(handlerBody)) !== null) {
      add(m[1] || m[2], "query", inferParamType(m[1] || m[2]));
    }
    const fromRouteRegex = /\[FromRoute(?:\(Name\s*=\s*"([^"]+)")?\)\]\s*(?:public\s+)?[A-Za-z[\]<>.]+\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((m = fromRouteRegex.exec(handlerBody)) !== null) {
      add(m[1] || m[2], "path", inferParamType(m[1] || m[2]));
    }
  } else if (framework === "php") {
    let m;
    const laravelRegex = /\$(?:request|req)->(?:query|q)\(\s*['"`]([a-zA-Z0-9_-]+)/g;
    while ((m = laravelRegex.exec(handlerBody)) !== null) add(m[1], "query", inferParamType(m[1]));
  } else if (framework === "ruby") {
    let m;
    const railsRegex = /params\[:(?:q)?["']?([a-zA-Z0-9_-]+)/g;
    while ((m = railsRegex.exec(handlerBody)) !== null) add(m[1], "query", inferParamType(m[1]));
  }

  return Array.from(params.values()).slice(0, 25);
}

/**
 * Infers the request body schema from validator usage in the handler:
 * Zod object parse, class-validator DTOs, Pydantic models, Go structs,
 * Mongoose `schema:` field, or plain destructure of `req.body`.
 */
export function extractRequestBody(
  handlerBody: string,
  method: string,
  _framework: "node" | "python" | "go" | "rust" | "jvm" | "dotnet" | "php" | "ruby"
): OperationBodySchema | undefined {
  if (!expectsRequestBody(method)) return undefined;

  // Pydantic / class-validator / DTO class references
  const dtoMatch =
    /@(?:Body|RequestBody|RequestPayload|InjectBody)\s*\(\s*\)?\s*(?:public\s+|private\s+)?[A-Za-z[\]<>.]+\s+([A-Z][A-Za-z0-9_]+)/.exec(handlerBody) ||
    /(?:body|payload|data)\s*:\s*([A-Z][A-Za-z0-9_]+)/.exec(handlerBody) ||
    /:\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(?:Body|Field)\s*\(/.exec(handlerBody);
  if (dtoMatch) {
    return { type: "object", properties: [], required: [], ref: dtoMatch[1] };
  }

  // Zod: body: z.object({ ... }).parse / schema.parse(req.body)
  const zodRegex = /z\.object\s*\(\s*\{([\s\S]*?)\}\s*\)/;
  const zodMatch = zodRegex.exec(handlerBody);
  if (zodMatch) {
    const parsed = parseFieldList(zodMatch[1]);
    if (parsed.properties.length > 0) return parsed;
  }

  // FastAPI: body params annotated with BaseModel type
  const pyBodyRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(?:Body|Form)\s*\(/g;
  let m;
  while ((m = pyBodyRegex.exec(handlerBody)) !== null) {
    return { type: "object", properties: [], required: [], ref: m[2] };
  }

  // Go binding structs
  const goBindRegex = /ShouldBind(?:JSON)?\s*\(\s*&([a-zA-Z][A-Za-z0-9_]*)\)|c\.BindJSON\s*\(\s*&([a-zA-Z][A-Za-z0-9_]*)/g;
  while ((m = goBindRegex.exec(handlerBody)) !== null) {
    const structName = m[1] || m[2];
    if (structName) return { type: "object", properties: [], required: [], ref: toPascalCase(structName) };
  }

  // req.body destructure fallback
  const destructureRegex = /const\s*\{([^}]+)\}\s*=\s*req(?:uest)?\.body/.exec(handlerBody) ||
    /(?:body|payload|data)\.(?:body)?\.?([a-zA-Z0-9_]+)\s*=/g.exec(handlerBody);
  if (destructureMatch(destructureRegex)) {
    const names = destructureRegex[1]
      .split(",")
      .map((s) => s.trim().split(/:\s*/)[0].trim())
      .filter(Boolean);
    if (names.length > 0) {
      return {
        type: "object",
        properties: names.slice(0, 30).map((n) => ({
          name: n,
          type: inferParamType(n) as string,
          required: true,
        })),
        required: names.slice(0, 30),
      };
    }
  }

  return undefined;
}

function destructureMatch(re: RegExpExecArray | null): re is RegExpExecArray {
  return re !== null && re[1] !== undefined;
}

/**
 * Infers response schemas from status codes and response payloads in handler
 * code: `res.status(n).json({...})`, `res.json({...})`, `return {...}`,
 * `@ResponseStatus`, and Go/Python return statements.
 */
export function extractResponses(
  handlerBody: string,
  _framework: "node" | "python" | "go" | "rust" | "jvm" | "dotnet" | "php" | "ruby"
): OperationResponse[] {
  const responses: Map<string, OperationResponse> = new Map();
  const setResponse = (statusCode: string, schema?: OperationResponse["schema"]) => {
    if (!responses.has(statusCode)) {
      responses.set(statusCode, {
        statusCode,
        description: describeStatus(statusCode),
        schema,
      });
    } else if (schema && !responses.get(statusCode)!.schema) {
      responses.get(statusCode)!.schema = schema;
    }
  };

  let m;
  // res.status(n).json({...}) / res.sendStatus(n)
  STATUS_CODE_REGEX.lastIndex = 0;
  while ((m = STATUS_CODE_REGEX.exec(handlerBody)) !== null) {
    setResponse(m[1] || m[2] || m[3] || m[4]);
  }

  // res.status(n).json({ ... }) with literal shape
  const statusJsonRegex = /(?:res|response|ctx|c)\s*\.\s*status\s*\(\s*(\d{3})\s*\)\s*\.\s*json\s*\(\s*\{([^}]*)\}/gs;
  while ((m = statusJsonRegex.exec(handlerBody)) !== null) {
    const parsed = parseFieldList(m[2]);
    setResponse(m[1], parsed.properties.length > 0 ? parsed : undefined);
  }

  // res.json({...}) → 200 with literal shape
  JSON_BODY_REGEX.lastIndex = 0;
  while ((m = JSON_BODY_REGEX.exec(handlerBody)) !== null) {
    const parsed = parseFieldList(m[1]);
    if (parsed.properties.length > 0) setResponse("200", parsed);
  }

  // Python / Go / Rust return of typed models
  const typedReturnRegex = /return\s+(?:[A-Za-z_.]+\s*\(\s*)?([A-Z][A-Za-z0-9_]+)(?:\s*\(|\s*\{)/g;
  while ((m = typedReturnRegex.exec(handlerBody)) !== null) {
    const code = responses.has("200") ? "200" : "200";
    if (!responses.has(code)) {
      responses.set(code, { statusCode: code, description: describeStatus(code), ref: m[1] });
    }
  }

  // Pydantic response_model
  const responseModelRegex = /response_model\s*=\s*([A-Z][A-Za-z0-9_]+)/.exec(handlerBody);
  if (responseModelRegex) {
    if (!responses.has("200")) {
      responses.set("200", { statusCode: "200", description: describeStatus("200"), ref: responseModelRegex[1] });
    }
  }

  if (responses.size === 0) {
    setResponse("200");
  }

  return Array.from(responses.values()).slice(0, 10);
}

/**
 * Detects security requirement usage in a handler: bearer tokens, API keys,
 * OAuth2, basic auth and session cookies.
 */
export function extractSecuritySchemes(handlerBody: string, context: string): string[] {
  const schemes = new Set<string>();
  if (/Bearer|Authorization|jwt|token|protect|guard|requireUser|authenticate|@UseGuards/i.test(context + handlerBody)) {
    schemes.add("bearerAuth");
  }
  if (/x-api-key|api[-_]?key|apiKey/i.test(context + handlerBody)) {
    schemes.add("apiKeyAuth");
  }
  if (/oauth|OAuth/i.test(context + handlerBody)) {
    schemes.add("oauth2");
  }
  if (/basic auth|Basic /i.test(context)) {
    schemes.add("basicAuth");
  }
  if (schemes.size === 0) schemes.add("none");
  return Array.from(schemes);
}

/**
 * Parses a Zod-like object literal body into a schema (fields + required).
 */
function parseFieldList(body: string): OperationBodySchema {
  const properties: SchemaProperty[] = [];
  const required: string[] = [];
  let m;
  const innerRegex = /([a-zA-Z0-9_]+)\s*:\s*([^,\n}]+)/g;
  while ((m = innerRegex.exec(body)) !== null) {
    const name = m[1];
    if (["if", "for", "while", "switch", "catch", "return", "await", "type", "enum"].includes(name)) continue;
    const rawType = m[2].trim();
    const isOptional = rawType.includes("optional()") || rawType.includes("?");
    const { type, format, itemsType, enumValues, ref } = mapFieldType(rawType);
    properties.push({ name, type, required: !isOptional, format, itemsType, enumValues, ref });
    if (!isOptional) required.push(name);
  }
  return {
    type: "object",
    properties: dedupeProps(properties),
    required: Array.from(new Set(required)),
  };
}

function dedupeProps(props: SchemaProperty[]): SchemaProperty[] {
  const seen = new Set<string>();
  return props.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
}

/**
 * Maps a raw field type expression (Zod, TS, Pydantic, Go) to an OAS type.
 */
function mapFieldType(raw: string): {
  type: string;
  format?: string;
  itemsType?: string;
  enumValues?: string[];
  ref?: string;
} {
  const t = raw.replace(/\s+/g, " ").trim();

  if (/z\.enum\(\s*\[([^\]]+)\]/.test(t)) {
    const vals = /z\.enum\(\s*\[([^\]]+)\]/.exec(t)![1].match(/['"`]([^'"`]+)['"`]/g) || [];
    return { type: "string", enumValues: vals.map((v) => v.replace(/['"`]/g, "")) };
  }
  if (/z\.array|Array<|\[\]/.test(t)) {
    const items = /Array<([^>]+)>|z\.array\(\s*(?:z\.)?([a-z]+)/i.exec(t);
    return { type: "array", itemsType: items ? (items[1] || items[2] || "string").toLowerCase() : "string" };
  }
  if (/z\.number|number|int|integer|Integer|Double|float64|float32/i.test(t)) {
    if (/int|Integer|float64/i.test(t)) return { type: "integer" };
    return { type: "number" };
  }
  if (/z\.boolean|boolean|bool\b/i.test(t)) return { type: "boolean" };
  if (/z\.date|Date\b|datetime/i.test(t)) return { type: "string", format: "date-time" };
  if (/z\.string|string|String|str\b|uuid|UUID/i.test(t)) {
    if (/uuid|UUID/.test(t)) return { type: "string", format: "uuid" };
    if (/email/.test(t)) return { type: "string", format: "email" };
    return { type: "string" };
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(t)) {
    return { type: "object", ref: t };
  }
  return { type: "string" };
}

function inferParamType(name: string): OperationParameter["type"] {
  const lower = name.toLowerCase();
  for (const [key, type] of Object.entries(TYPE_MAP)) {
    if (lower === key || lower.endsWith(key)) return type;
  }
  if (/^(is|has|should|can)[A-Z_]/.test(name)) return "boolean";
  return "string";
}

function toPascalCase(s: string): string {
  return s.replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase());
}

function describeStatus(code: string): string {
  const map: Record<string, string> = {
    "200": "OK",
    "201": "Created",
    "202": "Accepted",
    "204": "No Content",
    "301": "Moved Permanently",
    "302": "Found",
    "304": "Not Modified",
    "400": "Bad Request",
    "401": "Unauthorized",
    "403": "Forbidden",
    "404": "Not Found",
    "409": "Conflict",
    "422": "Unprocessable Entity",
    "429": "Too Many Requests",
    "500": "Internal Server Error",
    "503": "Service Unavailable",
  };
  return map[code] || `HTTP ${code}`;
}