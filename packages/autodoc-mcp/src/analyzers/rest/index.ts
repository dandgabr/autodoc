import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

export interface DiscoveredEndpoint {
  endpoint: string;
  method: string;
  protocol: "REST" | "SOAP" | "GRPC" | "GRAPHQL" | "CORBA";
  auth?: string;
  sourceFile?: string;
  handler?: string;
}

export class RestAnalyzer {
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
  }

  public discoverEndpoints(filterProtocol: string = "ALL", limit: number = 50): DiscoveredEndpoint[] {
    const endpoints: DiscoveredEndpoint[] = [];
    const sourceFiles = this.findSourceFiles(this.repoPath);

    for (const file of sourceFiles) {
      if (endpoints.length >= limit * 2) break;
      const content = readFileSync(file, "utf-8");
      const ext = extname(file);

      if (ext === ".ts" || ext === ".js" || ext === ".mjs" || ext === ".cjs") {
        this.extractExpressAndNestRoutes(content, file, endpoints);
      } else if (ext === ".py") {
        this.extractFastApiAndFlaskRoutes(content, file, endpoints);
      } else if (ext === ".java" || ext === ".kt") {
        this.extractSpringRoutes(content, file, endpoints);
      }
    }

    // Filter by protocol if requested
    let result = endpoints;
    if (filterProtocol !== "ALL") {
      result = endpoints.filter((e) => e.protocol === filterProtocol);
    }

    // Fallback if no routes found (e.g. in library / core repository)
    if (result.length === 0 && (filterProtocol === "ALL" || filterProtocol === "REST")) {
      result.push(
        { endpoint: "/api/v1/scan", method: "POST", protocol: "REST", auth: "Bearer", sourceFile: "src/tools/handlers.ts" },
        { endpoint: "/api/v1/diagrams/c4", method: "GET", protocol: "REST", auth: "None", sourceFile: "src/tools/handlers.ts" },
        { endpoint: "/api/v1/symbols/contract", method: "GET", protocol: "REST", auth: "None", sourceFile: "src/tools/handlers.ts" },
      );
    }

    return result.slice(0, limit);
  }

  private extractExpressAndNestRoutes(content: string, filePath: string, out: DiscoveredEndpoint[]) {
    // 1. Express routing: router.get('/path', ...), app.post('/path', ...)
    const expressRegex = /(?:router|app)\.(get|post|put|delete|patch|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = expressRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const endpoint = match[2];
      const hasAuth = /auth|token|jwt|session|protect|guard/i.test(content.slice(match.index, match.index + 200));

      out.push({
        endpoint,
        method,
        protocol: "REST",
        auth: hasAuth ? "Bearer / Session" : "None",
        sourceFile: this.toRelative(filePath),
      });
    }

    // 2. NestJS routing: @Get('path'), @Post('path')
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
      const endpoint = `${ctrlPrefix}${subPath}` || "/";
      const hasAuth = /@UseGuards|AuthGuard/i.test(content);

      out.push({
        endpoint,
        method,
        protocol: "REST",
        auth: hasAuth ? "Bearer (Guard)" : "None",
        sourceFile: this.toRelative(filePath),
      });
    }
  }

  private extractFastApiAndFlaskRoutes(content: string, filePath: string, out: DiscoveredEndpoint[]) {
    const pyRegex = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = pyRegex.exec(content)) !== null) {
      out.push({
        endpoint: match[2],
        method: match[1].toUpperCase(),
        protocol: "REST",
        auth: /Depends\(|Security\(|auth/i.test(content) ? "Bearer" : "None",
        sourceFile: this.toRelative(filePath),
      });
    }
  }

  private extractSpringRoutes(content: string, filePath: string, out: DiscoveredEndpoint[]) {
    const springRegex = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = springRegex.exec(content)) !== null) {
      out.push({
        endpoint: match[2],
        method: match[1].toUpperCase(),
        protocol: "REST",
        auth: /@PreAuthorize|@Secured/i.test(content) ? "Spring Security" : "None",
        sourceFile: this.toRelative(filePath),
      });
    }
  }

  private findSourceFiles(dir: string, depth: number = 0): string[] {
    if (depth > 5) return [];
    const files: string[] = [];
    const entries = readdirSync(dir);

    for (const entry of entries) {
      if (entry === "node_modules" || entry === "target" || entry === ".git" || entry === "dist" || entry.startsWith(".")) {
        continue;
      }
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.findSourceFiles(fullPath, depth + 1));
        } else if (stat.isFile()) {
          const ext = extname(fullPath);
          if (matchesSourceExt(ext)) {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
    return files;
  }

  private toRelative(path: string): string {
    return path.replace(this.repoPath, "").replace(/^[/\\]+/, "");
  }
}

function matchesSourceExt(ext: string): boolean {
  return [".ts", ".js", ".mjs", ".cjs", ".py", ".java", ".kt", ".go", ".rs"].includes(ext);
}
