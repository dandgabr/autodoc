# How to Connect AutoDoc to AI Agents and IDE Harnesses

Learn how to connect AutoDoc to your preferred AI coding environment using the standard Model Context Protocol (MCP) over stdio.

---

## Prerequisites

Before configuring your client:
1. Complete the installation and build steps in [Getting Started](../tutorials/getting-started.md).
2. Locate the absolute path to your repository clone (for example: `/home/daniel/Code/autodoc`).
3. Note the entry point script: `<REPO_ROOT>/packages/autodoc-mcp/dist/index.js`.

---

## 1. Claude Desktop

Add the `autodoc` entry to your `claude_desktop_config.json`:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "autodoc": {
      "command": "node",
      "args": [
        "/absolute/path/to/autodoc/packages/autodoc-mcp/dist/index.js"
      ],
      "env": {
        "AUTODOC_LOCALE": "en-US",
        "NODE_ENV": "production"
      }
    }
  }
}
```

Restart Claude Desktop. The hammer icon in the prompt window displays all seven AutoDoc tools.

---

## 2. Google Antigravity

In Antigravity, add the server to your MCP configuration (`~/.gemini/antigravity-cli/mcp_config.json` or project settings):

```json
{
  "mcpServers": {
    "autodoc": {
      "command": "node",
      "args": [
        "/absolute/path/to/autodoc/packages/autodoc-mcp/dist/index.js"
      ],
      "env": {
        "AUTODOC_LOCALE": "en-US"
      }
    }
  }
}
```

---

## 3. Cursor

Add the AutoDoc server in Cursor via **Settings** -> **Features** -> **MCP Servers** -> **Add New MCP Server**, or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "autodoc": {
      "command": "node",
      "args": [
        "/absolute/path/to/autodoc/packages/autodoc-mcp/dist/index.js"
      ],
      "env": {
        "AUTODOC_LOCALE": "en-US"
      }
    }
  }
}
```

---

## 4. Cline (VS Code Extension)

In the Cline extension settings, open the MCP servers tab or edit `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "autodoc": {
      "command": "node",
      "args": [
        "/absolute/path/to/autodoc/packages/autodoc-mcp/dist/index.js"
      ],
      "env": {
        "AUTODOC_LOCALE": "en-US"
      },
      "disabled": false,
      "autoApprove": [
        "autodoc_scan_repository",
        "autodoc_get_c4_diagram",
        "autodoc_get_symbol_contract",
        "autodoc_trace_data_flow",
        "autodoc_list_api_contracts"
      ]
    }
  }
}
```

---

## 5. OpenCode

Generate the configuration automatically using the built-in CLI flag:

```bash
node /absolute/path/to/autodoc/packages/autodoc-mcp/dist/index.js --print-opencode-config > opencode.json
```

Or configure `.opencode/mcp.json` directly:

```json
{
  "mcpServers": {
    "autodoc": {
      "command": "node",
      "args": [
        "/absolute/path/to/autodoc/packages/autodoc-mcp/dist/index.js"
      ],
      "env": {
        "AUTODOC_LOCALE": "en-US",
        "NODE_ENV": "production"
      }
    }
  }
}
```

---

## Verification

To verify that the MCP server communicates over stdio correctly, ask your agent:
> *"Scan this repository and give me a high-level C4 container diagram."*

Your agent calls `autodoc_scan_repository`, reads the cached graph, and returns a sanitized Mermaid diagram using `autodoc_get_c4_diagram`.
