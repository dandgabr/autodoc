import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
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
  GenerateAdrSchema,
  handleGenerateAdr,
  PurgeCacheSchema,
  handlePurgeCache,
} from "./tools/handlers.js";
import { loadNativeBinding } from "./binding.js";

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
            },
          },
        },
        {
          name: "autodoc_get_c4_diagram",
          description: "Generates XSS-free C4 diagrams (Levels 1 to 4) in Mermaid.js or Structurizr DSL with dynamic token budget pruning.",
          inputSchema: {
            type: "object",
            properties: {
              level: { type: "number", description: "C4 model level (1: Context, 2: Container, 3: Component, 4: Code). Default: 2." },
              max_nodes: { type: "number", description: "Maximum visible nodes to prevent LLM context exhaustion (10-100). Default: 35." },
              format: { type: "string", enum: ["mermaid", "structurizr"], description: "Output diagram format. Default: mermaid." },
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
              symbol_fqsn: { type: "string", description: "Fully Qualified Symbol Name (e.g. crate::module::function)." },
              include_body: { type: "boolean", description: "Whether to include full AST body. Default: false." },
            },
            required: ["symbol_fqsn"],
          },
        },
        {
          name: "autodoc_trace_data_flow",
          description: "Traces taint data flow paths from external sources through sanitizers to persistence/API sinks.",
          inputSchema: {
            type: "object",
            properties: {
              entrypoint_symbol: { type: "string", description: "Source entrypoint symbol." },
              max_depth: { type: "number", description: "Maximum traversal depth in call graph." },
            },
            required: ["entrypoint_symbol"],
          },
        },
        {
          name: "autodoc_list_api_contracts",
          description: "Inventories inbound and outbound service endpoints spanning 30 years of enterprise protocols (CORBA, SOAP, REST, gRPC).",
          inputSchema: {
            type: "object",
            properties: {
              protocol_filter: { type: "string", enum: ["ALL", "REST", "SOAP", "GRPC", "GRAPHQL", "CORBA"] },
              limit: { type: "number", description: "Pagination limit. Default: 50." },
              cursor: { type: "string", description: "Next page cursor." },
            },
          },
        },
        {
          name: "autodoc_list_socket_contracts",
          description: "Inventories realtime event contracts (Socket.io typed contracts, rooms, acknowledgements) and WebRTC signaling channels.",
          inputSchema: {
            type: "object",
            properties: {
              direction_filter: { type: "string", enum: ["ALL", "CLIENT_TO_SERVER", "SERVER_TO_CLIENT", "BIDIRECTIONAL"] },
              limit: { type: "number", description: "Pagination limit. Default: 50." },
            },
          },
        },
        {
          name: "autodoc_export_documentation",
          description: "Synthesizes and exports complete Diátaxis living documentation set (Tutorials, How-To, Reference, Architecture) to physical disk directory.",
          inputSchema: {
            type: "object",
            properties: {
              output_dir: { type: "string", description: "Target directory path on disk (e.g. ./docs)." },
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
      case "autodoc_generate_adr":
        return await handleGenerateAdr(GenerateAdrSchema.parse(args || {}));
      case "autodoc_purge_cache":
        return await handlePurgeCache(PurgeCacheSchema.parse(args || {}));
      default:
        throw new Error(`AUTODOC_E501: Unknown tool name: ${name}`);
    }
  });

  // Virtual Resources handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        { uri: "code://c4/2", name: "C4 Container Diagram", mimeType: "text/vnd.mermaid" },
        { uri: "code://graph/callgraph", name: "Canonical Call Graph", mimeType: "application/json" },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri.startsWith("code://c4/")) {
      return {
        contents: [
          {
            uri,
            mimeType: "text/vnd.mermaid",
            text: "graph TD\n    App[\"Core App\"] --> DB[\"Database\"]",
          },
        ],
      };
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ graph: "empty" }),
        },
      ],
    };
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
