import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, basename, dirname, relative } from "node:path";
import { isIgnoredDirectory, isTestPath } from "../utils.js";
import { LlmCandidateFilter, type EnrichmentReport } from "../llm-candidate-filter.js";
import type { SnapshotContext } from "../../analysis/snapshot.js";
import { readInventoryFiles, readVerifiedSource, StaleSourceError } from "../../analysis/source-reader.js";

export interface DiscoveredEndpoint {
  id?: string;
  endpoint: string;
  method: string;
  protocol: "REST" | "SOAP" | "GRPC" | "GRAPHQL" | "CORBA";
  auth?: string;
  sourceFile?: string;
  handler?: string;
  confidence?: "regex" | "llm-verified";
}

export interface RestAnalyzerOptions {
  includeTests?: boolean;
  snapshot?: SnapshotContext;
  /** Enable pass-2 LLM validation of ambiguous candidates (default off). */
  llmEnrichment?: boolean;
}

export class RestAnalyzer {
  private repoPath: string;
  private includeTests: boolean;
  private llmEnrichment: boolean;
  private snapshot?: SnapshotContext;
  /** Endpoint list retained as pass-1 catalog facts. */
  private lastEndpoints: DiscoveredEndpoint[] = [];
  /** Ambiguous pass-1 candidates staged for optional LLM validation. */
  public pendingLlmCandidates: Array<{ id: string; index: number; label: string; context: string }> = [];
  public lastEnrichmentReport: EnrichmentReport = {
    llmEnriched: false,
    candidatesReviewed: 0,
    candidatesRejected: 0,
    correctionsApplied: 0,
  };

  /**
   * Pass-2 LLM validation is advisory: verdicts never remove catalog facts.
   */
  public async applyLlmValidation(): Promise<EnrichmentReport & { endpoints: DiscoveredEndpoint[] }> {
    if (!this.llmEnrichment || this.pendingLlmCandidates.length === 0) {
      return { ...this.lastEnrichmentReport, endpoints: this.lastEndpoints };
    }
    const filter = new LlmCandidateFilter(true);
    const { verdicts, report } = await filter.validateCandidates(this.pendingLlmCandidates);
    this.lastEnrichmentReport = report;
    this.pendingLlmCandidates = [];
    return { ...report, advisory: report.advisory ?? "LLM verdicts are observations and do not alter endpoint facts.", endpoints: this.lastEndpoints };
  }

  constructor(repoPath: string = process.cwd(), options: RestAnalyzerOptions = {}) {
    this.repoPath = repoPath;
    this.includeTests = options.includeTests ?? false;
    this.llmEnrichment = options.llmEnrichment ?? false;
    this.snapshot = options.snapshot;
  }

  private readText(filePath: string): string {
    if (this.snapshot) return readVerifiedSource(this.snapshot, relative(this.snapshot.repositoryRoot, filePath).split("\\").join("/")).toString("utf8");
    return readFileSync(filePath, "utf-8");
  }

  public discoverEndpoints(filterProtocol: string = "ALL", limit: number = Number.MAX_SAFE_INTEGER, includeTests?: boolean): DiscoveredEndpoint[] {
    const endpoints: DiscoveredEndpoint[] = [];
    const effectiveIncludeTests = includeTests ?? this.includeTests;
    const sourceFiles = this.findSourceFiles(this.repoPath, 0, effectiveIncludeTests);

    // Pass 1: Build mount table (IoC, module registries, Express app.use, Fastify, FastAPI, Gin, etc.)
    const { fileToPrefixes, identifierToPrefixes, dirToPrefixes } = this.buildMountTable(sourceFiles);

    // Pass 2: Extract endpoints from each file with mounted prefixes
    const seen = new Set<string>();
    const ambiguous: Array<{ id: string; index: number; label: string; context: string }> = [];

    for (const file of sourceFiles) {
      const content = this.readText(file);
      const ext = extname(file);
      const relPath = this.toRelative(file);

      // Resolve candidate prefixes for this file
      const candidatePrefixes = this.resolvePrefixesForFile(file, relPath, fileToPrefixes, identifierToPrefixes, dirToPrefixes);

      const fileEndpoints: DiscoveredEndpoint[] = [];

      if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
        this.extractNodeRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      } else if (ext === ".py") {
        this.extractPythonRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      } else if (ext === ".go") {
        this.extractGoRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      } else if (ext === ".rs") {
        this.extractRustRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      } else if (ext === ".java" || ext === ".kt") {
        this.extractJvmRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      } else if (ext === ".cs") {
        this.extractDotnetRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      } else if (ext === ".php") {
        this.extractPhpRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      } else if (ext === ".rb") {
        this.extractRubyRoutes(content, relPath, candidatePrefixes, fileEndpoints);
      }

      for (const ep of fileEndpoints) {
        const key = `${ep.method}:${ep.endpoint}`;
        if (!seen.has(key)) {
          seen.add(key);
          // Heuristic ambiguity signal: no mount prefix resolved (route may
          // be mislocated) — these are the pass-2 LLM candidates.
          if (this.llmEnrichment && candidatePrefixes.length === 0) {
            const id = this.endpointId(ep, relPath);
            ambiguous.push({
              id,
              index: endpoints.length,
              label: `${ep.method} ${ep.endpoint}`,
              context: content.slice(Math.max(0, content.indexOf(ep.endpoint) - 300), content.indexOf(ep.endpoint) + 500),
            });
          }
          endpoints.push({ ...ep, id: this.endpointId(ep, relPath), confidence: "regex" });
        }
      }
    }

    if (this.llmEnrichment && ambiguous.length > 0) {
      this.pendingLlmCandidates = ambiguous;
    }

    // Filter by protocol if requested
    let result = endpoints;
    if (filterProtocol !== "ALL") {
      result = endpoints.filter((e) => e.protocol === filterProtocol);
    }

    result = result.slice(0, limit);
    this.lastEndpoints = result;
    return result;
  }

  private endpointId(endpoint: Pick<DiscoveredEndpoint, "method" | "endpoint">, sourceFile: string): string {
    const digest = createHash("sha256").update(`${endpoint.method.toUpperCase()}\0${endpoint.endpoint}\0${sourceFile}`).digest("hex");
    return `endpoint:${digest.slice(0, 24)}`;
  }

  private buildMountTable(sourceFiles: string[]) {
    const fileToPrefixes = new Map<string, Set<string>>();
    const identifierToPrefixes = new Map<string, Set<string>>();
    const dirToPrefixes = new Map<string, Set<string>>();

    const relevantFiles: Array<{ file: string; content: string }> = [];

    // Pass 1: Read relevant files and collect all route mounts and prefixes
    for (const file of sourceFiles) {
      const relPath = this.toRelative(file);
      if (
        !relPath.includes("route") &&
        !relPath.includes("app") &&
        !relPath.includes("server") &&
        !relPath.includes("index") &&
        !relPath.includes("module") &&
        !relPath.includes("main")
      ) {
        continue;
      }

      let content = "";
      try {
        content = this.readText(file);
      } catch (error) {
        if (error instanceof StaleSourceError) throw error;
        continue;
      }

      relevantFiles.push({ file, content });

      // 1. Express / Koa mounts: app.use('/api/users', usersRouter)
      const appUseRegex = /(?:app|router|server)\.use\s*\(\s*(?:\[([^\]]+)\]|['"`]([^'"`]+)['"`])\s*,\s*([a-zA-Z0-9_]+)/g;
      let match;
      while ((match = appUseRegex.exec(content)) !== null) {
        const prefixes = match[1]
          ? match[1].split(",").map((s) => s.trim().replace(/['"`]/g, ""))
          : [match[2]];
        const identifier = match[3];

        for (const p of prefixes) {
          if (!p || !p.startsWith("/")) continue;
          if (!identifierToPrefixes.has(identifier)) {
            identifierToPrefixes.set(identifier, new Set());
          }
          identifierToPrefixes.get(identifier)!.add(p);
        }
      }

      // 2. Module registry objects: routers: [{ path: '/api/module', router: moduleRouter }]
      const moduleRouterRegex = /path:\s*['"`]([^'"`]+)['"`]\s*,\s*router:\s*([a-zA-Z0-9_]+)/g;
      while ((match = moduleRouterRegex.exec(content)) !== null) {
        const prefix = match[1];
        const identifier = match[2];
        if (prefix && prefix.startsWith("/")) {
          if (!identifierToPrefixes.has(identifier)) {
            identifierToPrefixes.set(identifier, new Set());
          }
          identifierToPrefixes.get(identifier)!.add(prefix);

          // Associate containing module directory
          const modDir = dirname(file);
          if (!dirToPrefixes.has(modDir)) {
            dirToPrefixes.set(modDir, new Set());
          }
          dirToPrefixes.get(modDir)!.add(prefix);
        }
      }

      // 3. Fastify register: fastify.register(userRoutes, { prefix: '/api/v1' })
      const fastifyRegex = /\.register\s*\(\s*([a-zA-Z0-9_]+)\s*,\s*\{\s*prefix:\s*['"`]([^'"`]+)['"`]/g;
      while ((match = fastifyRegex.exec(content)) !== null) {
        const identifier = match[1];
        const prefix = match[2];
        if (!identifierToPrefixes.has(identifier)) {
          identifierToPrefixes.set(identifier, new Set());
        }
        identifierToPrefixes.get(identifier)!.add(prefix);
      }

      // 4. FastAPI / Python: app.include_router(users_router, prefix="/api/users")
      const pyIncludeRegex = /include_router\s*\(\s*([a-zA-Z0-9_]+)[^)]*prefix\s*=\s*['"`]([^'"`]+)['"`]/g;
      while ((match = pyIncludeRegex.exec(content)) !== null) {
        const identifier = match[1];
        const prefix = match[2];
        if (!identifierToPrefixes.has(identifier)) {
          identifierToPrefixes.set(identifier, new Set());
        }
        identifierToPrefixes.get(identifier)!.add(prefix);
      }
    }

    // Pass 2: Map exact imports and requires to resolved file paths
    for (const { file, content } of relevantFiles) {
      // ES Imports: import usersRouter from "./routes/users.js" or import { usersRouter } from ...
      const importRegex = /import\s+(?:\{([^}]+)\}|([a-zA-Z0-9_]+))\s+from\s+['"`]([^'"`]+)['"`]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importedNames = match[1]
          ? match[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
          : [match[2]];
        const importPath = match[3];
        if (!importPath.startsWith(".")) continue;

        const resolvedPath = this.resolveImportPath(dirname(file), importPath);
        if (resolvedPath) {
          for (const name of importedNames) {
            if (identifierToPrefixes.has(name)) {
              if (!fileToPrefixes.has(resolvedPath)) {
                fileToPrefixes.set(resolvedPath, new Set());
              }
              for (const p of identifierToPrefixes.get(name)!) {
                fileToPrefixes.get(resolvedPath)!.add(p);
              }
            }
          }
        }
      }

      // CommonJS requires: const usersRouter = require("./routes/users")
      const requireRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|([a-zA-Z0-9_]+))\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        const reqNames = match[1]
          ? match[1].split(",").map((s) => s.trim().split(/\s*:\s*/).pop()!.trim())
          : [match[2]];
        const reqPath = match[3];
        if (!reqPath.startsWith(".")) continue;

        const resolvedPath = this.resolveImportPath(dirname(file), reqPath);
        if (resolvedPath) {
          for (const name of reqNames) {
            if (identifierToPrefixes.has(name)) {
              if (!fileToPrefixes.has(resolvedPath)) {
                fileToPrefixes.set(resolvedPath, new Set());
              }
              for (const p of identifierToPrefixes.get(name)!) {
                fileToPrefixes.get(resolvedPath)!.add(p);
              }
            }
          }
        }
      }
    }

    return { fileToPrefixes, identifierToPrefixes, dirToPrefixes };
  }

  private resolveImportPath(currentDir: string, importPath: string): string | null {
    const candidateBase = join(currentDir, importPath.replace(/\.js$/, ""));
    const exts = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];

    for (const ext of exts) {
      const full = candidateBase + ext;
      if (existsSync(full)) return full;
    }
    return null;
  }

  private resolvePrefixesForFile(
    file: string,
    _relPath: string,
    fileToPrefixes: Map<string, Set<string>>,
    identifierToPrefixes: Map<string, Set<string>>,
    dirToPrefixes: Map<string, Set<string>>
  ): string[] {
    // 1. Direct file match (highest precedence: exact import-bound file from app.use/register/include_router)
    if (fileToPrefixes.has(file) && fileToPrefixes.get(file)!.size > 0) {
      return Array.from(fileToPrefixes.get(file)!);
    }

    // 2. Directory match (e.g. module folder with registered router)
    const matchingDirPrefixes = new Set<string>();
    for (const [dir, dirPrefixes] of dirToPrefixes.entries()) {
      if (file.startsWith(dir)) {
        for (const p of dirPrefixes) matchingDirPrefixes.add(p);
      }
    }
    if (matchingDirPrefixes.size > 0) {
      return Array.from(matchingDirPrefixes);
    }

    // 3. Exact identifier / filename match (only if file has no direct or directory binding)
    const base = basename(file, extname(file))
      .replace(/\.routes?$/, "")
      .replace(/-router$/, "")
      .replace(/Router$/, "")
      .replace(/Controller$/, "");
    const baseClean = base.toLowerCase().replace(/[-_]/g, "");

    const prefixes = new Set<string>();
    for (const [id, idPrefixes] of identifierToPrefixes.entries()) {
      const idClean = id.toLowerCase().replace(/router$/, "").replace(/controller$/, "").replace(/[-_]/g, "");
      if (idClean === baseClean && baseClean.length > 0) {
        for (const p of idPrefixes) prefixes.add(p);
      }
    }

    return Array.from(prefixes);
  }

  private extractNodeRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    // 1. Express / Router / App methods
    const routeRegex = /(?:router|app|fastify|server)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const rawEndpoint = match[2];
      const hasAuth = /auth|token|jwt|session|protect|guard|requireUser|adminOnly/i.test(
        content.slice(match.index, match.index + 250)
      );

      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }

    // 2. router.route('/path').get(...).post(...)
    const chainRouteRegex = /router\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.(get|post|put|delete|patch)/gi;
    while ((match = chainRouteRegex.exec(content)) !== null) {
      const rawEndpoint = match[1];
      const method = match[2].toUpperCase();
      const hasAuth = /auth|token|jwt|session|guard/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }

    // 3. NestJS routing: @Controller('prefix') + @Get('path')
    const nestControllerRegex = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
    const nestMethodRegex = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;

    let ctrlPrefix = "";
    const ctrlMatch = nestControllerRegex.exec(content);
    if (ctrlMatch) {
      ctrlPrefix = ctrlMatch[1] ? `/${ctrlMatch[1].replace(/^\//, "")}` : "";
    }

    while ((match = nestMethodRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const subPath = match[2] ? `/${match[2].replace(/^\//, "")}` : "";
      const rawEndpoint = `${ctrlPrefix}${subPath}` || "/";
      const hasAuth = /@UseGuards|AuthGuard/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }
  }

  private extractPythonRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const pyRegex = /@(?:app|router|api)\.(get|post|put|delete|patch|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = pyRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const rawEndpoint = match[2];
      const hasAuth = /Depends\(|Security\(|auth|token/i.test(content.slice(match.index, match.index + 200));
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }
  }

  private extractGoRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const goRegex = /\.(GET|POST|PUT|DELETE|PATCH|Handle|HandleFunc)\s*\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = goRegex.exec(content)) !== null) {
      const m = match[1].toUpperCase();
      const method = m === "HANDLE" || m === "HANDLEFUNC" ? "GET" : m;
      const rawEndpoint = match[2];
      const hasAuth = /Auth|Token|JWT|Session/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }
  }

  private extractRustRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const rustRegex = /#\[(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
    let match;
    while ((match = rustRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const rawEndpoint = match[2];
      const hasAuth = /Auth|Token|Claims|guard/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }

    const axumRegex = /\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|delete|patch)\s*\(/gi;
    while ((match = axumRegex.exec(content)) !== null) {
      const rawEndpoint = match[1];
      const method = match[2].toUpperCase();
      const hasAuth = /Auth|Token|Claims/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }
  }

  private extractJvmRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const springRegex = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = springRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const rawEndpoint = match[2];
      const hasAuth = /@PreAuthorize|@Secured|Security/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }
  }

  private extractDotnetRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const dotnetRegex = /\[Http(Get|Post|Put|Delete|Patch)\s*(?:\(\s*["']([^"']+)["']\s*\))?\]/gi;
    let match;
    while ((match = dotnetRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const rawEndpoint = match[2] || "/";
      const hasAuth = /\[Authorize\]/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }
  }

  private extractPhpRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const phpRegex = /Route::(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = phpRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const rawEndpoint = match[2];
      const hasAuth = /middleware\(['"]auth/i.test(content);
      this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
    }
  }

  private extractRubyRoutes(
    content: string,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const rubyRegex = /(?:match\s+['"`]([^'"`]+)['"`]|(get|post|put|delete|patch)\s+['"`]([^'"`]+)['"`])/gi;
    let match;
    while ((match = rubyRegex.exec(content)) !== null) {
      const method = (match[2] || "GET").toUpperCase();
      const rawEndpoint = match[1] || match[3];
      if (rawEndpoint && rawEndpoint.startsWith("/")) {
        const hasAuth = /authenticate_user|before_action :authenticate/i.test(content);
        this.addNormalizedEndpoints(rawEndpoint, method, hasAuth, relPath, candidatePrefixes, out);
      }
    }
  }

  private addNormalizedEndpoints(
    rawEndpoint: string,
    method: string,
    hasAuth: boolean,
    relPath: string,
    candidatePrefixes: string[],
    out: DiscoveredEndpoint[]
  ) {
    const auth = hasAuth ? "Bearer / Session" : "None";

    if (candidatePrefixes.length > 0) {
      for (const prefix of candidatePrefixes) {
        const combined = this.joinPrefixAndPath(prefix, rawEndpoint);
        out.push({
          endpoint: combined,
          method,
          protocol: "REST",
          auth,
          sourceFile: relPath,
        });
      }
    } else {
      out.push({
        endpoint: rawEndpoint.startsWith("/") ? rawEndpoint : `/${rawEndpoint}`,
        method,
        protocol: "REST",
        auth,
        sourceFile: relPath,
      });
    }
  }

  private joinPrefixAndPath(prefix: string, path: string): string {
    const cleanPrefix = prefix.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    if (!cleanPrefix) return cleanPath;
    if (cleanPath === "/") return cleanPrefix || "/";
    if (cleanPrefix === cleanPath) return cleanPrefix;
    return `${cleanPrefix}${cleanPath}`;
  }

  private findSourceFiles(dir: string, depth: number = 0, includeTests: boolean = this.includeTests): string[] {
    if (this.snapshot) return readInventoryFiles(this.snapshot)
      .filter((file) => file.category === "source" && file.contentSha256 && !file.readError && !file.excludedReason)
      .filter((file) => includeTests || !isTestPath(file.path))
      .filter((file) => matchesSourceExt(extname(file.path)))
      .map((file) => join(this.snapshot!.repositoryRoot, file.path));
    if (depth > 15) return [];
    const files: string[] = [];

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (isIgnoredDirectory(entry, includeTests)) {
          continue;
        }

        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.findSourceFiles(fullPath, depth + 1, includeTests));
        } else if (stat.isFile()) {
          if (!includeTests && isTestPath(fullPath)) {
            continue;
          }
          const ext = extname(fullPath);
          if (matchesSourceExt(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
        if (error instanceof StaleSourceError) throw error;
      // Skip unreadable files
    }

    return files;
  }

  private toRelative(path: string): string {
    return path.replace(this.repoPath, "").replace(/^[/\\]+/, "");
  }
}

function matchesSourceExt(ext: string): boolean {
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".java",
    ".kt",
    ".go",
    ".rs",
    ".cs",
    ".php",
    ".rb",
  ].includes(ext);
}
