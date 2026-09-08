/**
 * XSS-Free Visual Diagram Generator for Mermaid.js and Structurizr DSL.
 * Strictly adheres to OWASP LLM05: Output Handling.
 * Enforces zero click/href/callback directives and escapes HTML entities.
 */

export interface DiagramOptions {
  level: number;
  format?: "mermaid" | "structurizr";
  title?: string;
  nodes?: Array<{ id: string; label: string; desc?: string; type?: "person" | "system" | "container" | "component" | "external" }>;
  edges?: Array<{ from: string; to: string; label?: string }>;
}

export class DiagramRenderer {
  static escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/javascript:/gi, "[blocked-uri]:")
      .replace(/onerror/gi, "[blocked-attr]");
  }

  static escapeMermaidLabel(text: string): string {
    return this.escapeHtml(text);
  }

  static sanitizeMermaidId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  static sanitizeUri(uri: string): string {
    const trimmed = uri.trim();
    if (/^(javascript|data|vbscript):/i.test(trimmed)) {
      return "#blocked";
    }
    return trimmed;
  }

  static render(options: DiagramOptions): string {
    const format = options.format || "mermaid";
    if (format === "structurizr") {
      return this.renderStructurizr(options);
    }
    return this.renderMermaid(options);
  }

  static renderC4ContextMermaid(
    title: string,
    nodes: Array<{ id: string; label: string; type?: string; description?: string }>,
    edges: Array<{ from: string; to: string; label?: string }>
  ): string {
    const lines: string[] = ["flowchart TB"];
    lines.push(`    %% ${this.escapeMermaidLabel(title)}`);
    lines.push("    subgraph Boundary_System [\"System Boundary\"]");

    for (const n of nodes) {
      const safeId = this.sanitizeMermaidId(n.id);
      const safeLabel = this.escapeMermaidLabel(n.label);
      const safeDesc = n.description ? `<br/>${this.escapeMermaidLabel(n.description)}` : "";
      lines.push(`        ${safeId}[\"${safeLabel}${safeDesc}\"]`);
    }
    lines.push("    end");

    for (const e of edges) {
      const safeFrom = this.sanitizeMermaidId(e.from);
      const safeTo = this.sanitizeMermaidId(e.to);
      if (e.label) {
        lines.push(`    ${safeFrom} -->|\"${this.escapeMermaidLabel(e.label)}\"| ${safeTo}`);
      } else {
        lines.push(`    ${safeFrom} --> ${safeTo}`);
      }
    }

    return lines.join("\n");
  }

  static renderStructurizrDsl(
    title: string,
    nodes: Array<{ id: string; label: string; type?: string; description?: string }>,
    edges: Array<{ from: string; to: string; label?: string }>
  ): string {
    const lines: string[] = [
      `workspace "${this.escapeDslString(title)}" {`,
      "    model {",
    ];

    for (const n of nodes) {
      const safeId = this.sanitizeMermaidId(n.id);
      const safeLabel = this.escapeDslString(n.label);
      const safeDesc = n.description ? ` "${this.escapeDslString(n.description)}"` : "";
      const kind = n.type === "person" ? "person" : "softwareSystem";
      lines.push(`        ${safeId} = ${kind} "${safeLabel}"${safeDesc}`);
    }

    for (const e of edges) {
      const safeFrom = this.sanitizeMermaidId(e.from);
      const safeTo = this.sanitizeMermaidId(e.to);
      const label = e.label ? ` "${this.escapeDslString(e.label)}"` : "";
      lines.push(`        ${safeFrom} -> ${safeTo}${label}`);
    }

    lines.push("    }");
    lines.push("}");
    return lines.join("\n");
  }

  private static escapeDslString(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private static renderMermaid(options: DiagramOptions): string {
    const lines: string[] = ["graph TD"];

    if (options.title) {
      lines.push(`    %% Title: ${this.escapeHtml(options.title)}`);
    }

    const nodes = options.nodes || [];
    for (const n of nodes) {
      const safeId = this.sanitizeMermaidId(n.id);
      const safeLabel = this.escapeHtml(n.label);
      const safeDesc = n.desc ? `<br/>${this.escapeHtml(n.desc)}` : "";
      lines.push(`    ${safeId}["${safeLabel}${safeDesc}"]`);
    }

    const edges = options.edges || [];
    for (const e of edges) {
      const safeFrom = this.sanitizeMermaidId(e.from);
      const safeTo = this.sanitizeMermaidId(e.to);
      if (e.label) {
        const safeEdgeLabel = this.escapeHtml(e.label);
        lines.push(`    ${safeFrom} -->|"${safeEdgeLabel}"| ${safeTo}`);
      } else {
        lines.push(`    ${safeFrom} --> ${safeTo}`);
      }
    }

    return lines.join("\n");
  }

  private static renderStructurizr(options: DiagramOptions): string {
    const title = options.title || "AutoDoc Inspected System";
    const nodes = (options.nodes || []).map(n => ({ ...n, description: n.desc }));
    return this.renderStructurizrDsl(title, nodes, options.edges || []);
  }
}
