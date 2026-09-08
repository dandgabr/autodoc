# Tutorial: Getting Started with AutoDoc Code Explorer

Learn how to install, build, and run your first codebase architectural scan using AutoDoc MCP.

---

## What You Will Build

In this 10-minute tutorial, you will:
1. Build the high-performance Rust core engine.
2. Compile the TypeScript Model Context Protocol (MCP) server.
3. Run a scan against a local repository.
4. Generate and inspect an interactive C4 container diagram.

---

## Prerequisites

Ensure your machine has the following tools installed:
- **Node.js**: v20.0.0 or higher (`node --version`)
- **Rust toolchain**: 1.85.0 or higher (`cargo --version`)
- **Git**: For version control traversal (`git --version`)

---

## Step 1: Clone the Repository

Clone the project from GitHub and switch to the repository directory:

```bash
git clone https://github.com/dandgabr/autodoc.git
cd autodoc
```

---

## Step 2: Install Node.js Workspaces

Install all workspace dependencies across packages:

```bash
npm install
```

---

## Step 3: Build the Native Core Engine

Compile the Rust core into an optimized native Node-API library:

```bash
npm run build -w @autodoc/core
```

This compiles `crates/autodoc-core` using `napi build --platform --release` and outputs `autodoc-core.node` inside `crates/autodoc-core/`.

---

## Step 4: Build the TypeScript MCP Server

Compile the TypeScript server:

```bash
npm run build -w @autodoc/mcp
```

This generates production-ready ES modules in `packages/autodoc-mcp/dist/`.

---

## Step 5: Verify Your Build with Tests

Run the complete test suite across Rust and TypeScript packages:

```bash
# Run Rust unit, FFI bridge, and SQLite WAL stress tests
cargo test -p autodoc-core

# Run TypeScript Vitest suite (FFI bridge, tools, XSS hardening, i18n, E2E)
npm test -w @autodoc/mcp
```

All 17 Rust tests and 35 TypeScript tests should pass cleanly.

---

## Step 6: Generate an OpenCode Configuration

AutoDoc includes a built-in flag to generate client configurations. Run:

```bash
node packages/autodoc-mcp/dist/index.js --print-opencode-config
```

The server prints a JSON configuration to `stdout`. You can direct this output into your OpenCode or Claude Desktop configuration file.

---

## Next Steps

Now that you have a working AutoDoc build:
- Connect AutoDoc to your AI agent harness: read [How to Connect AutoDoc to AI Agents](../how-to/connect-to-agents.md).
- Explore the complete list of tools: check the [MCP Tools Reference](../reference/tools.md).
- Understand how the memory-efficient hybrid engine operates: read [Hybrid Engine Architecture](../explanation/hybrid-architecture.md).
