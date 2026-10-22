import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "./logger.js";
import {
  ScanRepositorySchema,
  handleScanRepository,
  GetC4DiagramSchema,
  handleGetC4Diagram,
  GetSymbolContractSchema,
  handleGetSymbolContract,
  TraceDataFlowSchema,
  handleTraceDataFlow,
  ListApiContractsSchema,
  handleListApiContracts,
  ListSocketContractsSchema,
  handleListSocketContracts,
  ExportDocumentationSchema,
  handleExportDocumentation,
  ExportOpenApiSchema,
  handleExportOpenApi,
  GenerateAdrSchema,
  handleGenerateAdr,
  PurgeCacheSchema,
  handlePurgeCache,
  LlmStatusSchema,
  handleLlmStatus,
  ARCHITECTURE_MAP_RESOURCES,
  ARCHITECTURE_MAP_RESOURCE_TEMPLATES,
  handleReadMapResource,
} from "./tools/handlers.js";
import { loadNativeBinding } from "./binding.js";
export { WorkspaceAnalyzer } from "./analyzers/workspace.js";
export { ContainerInfraAnalyzer } from "./analyzers/containers.js";

export function createServer(): Server {
  const server = new Server(
    {
      name: "autodoc-code-explorer",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "autodoc_scan_repository",
          description: "Discovers tech stack, TIOBE languages, manifests, and LOC metrics with parallel Rayon scanner and SQLite WAL.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Absolute path to the repository root." },
              maxSourceBytes: { type: "integer", minimum: 1, maximum: 4194304, description: "Per-source byte limit (default 4194304)." },
              workers: { type: "integer", minimum: 1, maximum: 4, description: "Bounded scan workers (default 4)." },
              queueCapacity: { type: "integer", minimum: 1, maximum: 16, description: "Maximum queued files (default 16)." },
              batchSize: { type: "integer", minimum: 1, maximum: 256, description: "Persistence batch size (default 256)." },
            },
          },
        },
        {
          name: "autodoc_get_c4_diagram",
          description: "Generates XSS-free C4 diagrams (Levels 1 to 4) in Mermaid.js or Structurizr DSL with dynamic token budget pruning.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Target repository path (optional, defaults to last scanned path or cwd)." },
              level: { type: "number", description: "C4 model level (1: Context, 2: Container, 3: Component, 4: Code). Default: 2." },
              max_nodes: { type: "number", description: "Maximum visible nodes to prevent LLM context exhaustion (10-100). Default: 35." },
              format: { type: "string", enum: ["mermaid", "structurizr"], description: "Output diagram format. Default: mermaid." },
              scan_id: { type: "string", description: "Optional retained snapshot generation to query." },
              locale: { type: "string", description: "BCP 47 localization tag (e.g. en-US, pt-BR, es-ES). Default: en-US." },
            },
          },
        },
        {
          name: "autodoc_get_symbol_contract",
          description: "Extracts AST function/class signature, parameters, return type, and cyclomatic complexity enclosed in semantic prompt guard.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Target repository path (optional, defaults to last scanned path or cwd)." },
              symbol_fqsn: { type: "string", description: "Fully Qualified Symbol Name (e.g. crate::module::function)." },
              include_body: { type: "boolean", description: "Whether to include full AST body. Default: false." },
            },
            required: ["symbol_fqsn"],
          },
        },
        {
          name: "autodoc_trace_data_flow",
          description: "Reports verified call-graph paths. This tool does not prove taint propagation or sanitization.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Target repository path (optional, defaults to last scanned path or cwd)." },
              entrypoint_symbol: { type: "string", description: "Source entrypoint symbol." },
              target_sink: { type: "string", description: "Optional destination symbol to search for." },
              max_depth: { type: "number", description: "Maximum traversal depth in call graph." },
            },
            required: ["entrypoint_symbol"],
          },
        },
        {
          name: "autodoc_list_api_contracts",
          description: "Lists verified API contracts from one immutable scan generation. Pages are ordered, report the filtered total and coverage, and cursors bind to repository, scan, collection, and filters.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Target repository path (optional, defaults to last scanned path or cwd)." },
              protocol_filter: { type: "string", enum: ["ALL", "REST", "SOAP", "GRPC", "GRAPHQL", "CORBA"] },
              limit: { type: "number", description: "Pagination limit. Default: 50." },
              cursor: { type: "string", description: "Next page cursor bound to the current repository, scan, catalog, and filters." },
              scan_id: { type: "string", description: "Optional retained scan generation to query." },
              include_tests: { type: "boolean", description: "Whether to include test suites and mock files (default: false)." },
            },
          },
        },
        {
          name: "autodoc_list_socket_contracts",
          description: "Lists verified realtime contracts from one immutable scan generation. Pages are ordered, report the filtered total and coverage, and cursors bind to repository, scan, collection, and filters.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Target repository path (optional, defaults to last scanned path or cwd)." },
              direction_filter: { type: "string", enum: ["ALL", "CLIENT_TO_SERVER", "SERVER_TO_CLIENT", "BIDIRECTIONAL"] },
              limit: { type: "number", description: "Pagination limit. Default: 50." },
              cursor: { type: "string", description: "Next page cursor bound to the current repository, scan, catalog, and filters." },
              scan_id: { type: "string", description: "Optional retained scan generation to query." },
              include_tests: { type: "boolean", description: "Whether to include test suites and mock files (default: false)." },
            },
          },
        },
        {
          name: "autodoc_export_openapi",
          description: "Compiles a complete OpenAPI 3.1 contract from static code analysis: parameters, request bodies, response schemas and security, with $ref components.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Target repository path (optional, defaults to last scanned path or cwd)." },
              title: { type: "string", description: "API title for the info section." },
              version: { type: "string", description: "API version for the info section." },
              server_url: { type: "string", description: "Base server URL for the contract." },
              output_dir: { type: "string", description: "Optional directory to write openapi.json to disk. When omitted the document is returned inline." },
              include_tests: { type: "boolean", description: "Whether to include test suites and mock files (default: false)." },
            },
          },
        },
        {
          name: "autodoc_llm_status",
          description: "Reports host memory/VRAM, auto-selected local LLM profile (small/mid/large), active model and availability of LLM enrichment.",
          inputSchema: {
            type: "object",
            properties: {
              model_profile: { type: "string", enum: ["small", "mid", "large"], description: "Optional model profile to probe loading with." },
            },
          },
        },
        {
          name: "autodoc_export_documentation",
          description: "Synthesizes and exports complete Diátaxis living documentation set (Tutorials, How-To, Reference, Architecture) to physical disk directory.",
          inputSchema: {
            type: "object",
            properties: {
              repository_path: { type: "string", description: "Target repository path (optional, defaults to last scanned path or cwd)." },
              output_dir: { type: "string", description: "Target directory path on disk (e.g. ./docs)." },
              include_tests: { type: "boolean", description: "Whether to include test suites and mock files (default: false)." },
            },
          },
        },
        {
          name: "autodoc_generate_adr",
          description: "Synthesizes architectural decision records in localized Markdown MADR format.",
          inputSchema: {
            type: "object",
            properties: {
              topic: { type: "string", description: "Architecture topic title." },
              decision: { type: "string", description: "Accepted technical decision." },
              locale: { type: "string", description: "Target locale (en-US, pt-BR, es-ES)." },
            },
            required: ["topic", "decision"],
          },
        },
        {
          name: "autodoc_purge_cache",
          description: "Complies with GDPR/LGPD Right to be Forgotten by purging, checkpointing, and vacuuming local SQLite storage.",
          inputSchema: {
            type: "object",
            properties: {
              confirm: { type: "boolean", description: "Explicit confirmation to purge cache." },
            },
          },
        },
      ],
    };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "autodoc_scan_repository":
        return await handleScanRepository(ScanRepositorySchema.parse(args || {}));
      case "autodoc_get_c4_diagram":
        return await handleGetC4Diagram(GetC4DiagramSchema.parse(args || {}));
      case "autodoc_get_symbol_contract":
        return await handleGetSymbolContract(GetSymbolContractSchema.parse(args || {}));
      case "autodoc_trace_data_flow":
        return await handleTraceDataFlow(TraceDataFlowSchema.parse(args || {}));
      case "autodoc_list_api_contracts":
        return await handleListApiContracts(ListApiContractsSchema.parse(args || {}));
      case "autodoc_list_socket_contracts":
        return await handleListSocketContracts(ListSocketContractsSchema.parse(args || {}));
      case "autodoc_export_documentation":
        return await handleExportDocumentation(ExportDocumentationSchema.parse(args || {}));
      case "autodoc_export_openapi":
        return await handleExportOpenApi(ExportOpenApiSchema.parse(args || {}));
      case "autodoc_generate_adr":
        return await handleGenerateAdr(GenerateAdrSchema.parse(args || {}));
      case "autodoc_purge_cache":
        return await handlePurgeCache(PurgeCacheSchema.parse(args || {}));
      case "autodoc_llm_status":
        return await handleLlmStatus(LlmStatusSchema.parse(args || {}));
      default:
        throw new Error(`AUTODOC_E501: Unknown tool name: ${name}`);
    }
  });

  // Virtual Resources handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: [...ARCHITECTURE_MAP_RESOURCES] };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [...ARCHITECTURE_MAP_RESOURCE_TEMPLATES] };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    return handleReadMapResource(uri);
  });

  return server;
}

export async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--print-opencode-config")) {
    const config = {
      mcpServers: {
        autodoc: {
          command: "node",
          args: [process.argv[1]],
          env: {
            AUTODOC_LOCALE: "en-US",
            NODE_ENV: "production",
          },
        },
      },
    };
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    process.exit(0);
  }

  // Initialize native Rust telemetry directed to stderr
  try {
    const native = loadNativeBinding();
    native.initLogger();
  } catch (e: any) {
    Logger.warn("AUTODOC_W001", "Native logger initialization skipped or fallback: " + e?.message);
  }

  Logger.info("Starting AutoDoc Code Explorer MCP Server in stdio mode");
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  Logger.info("AutoDoc MCP Server cleanly connected to stdio transport");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((err) => {
    Logger.error("AUTODOC_E999", "Fatal error running MCP server: " + err?.message);
    process.exit(1);
  });
}
