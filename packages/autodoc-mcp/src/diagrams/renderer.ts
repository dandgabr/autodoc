/**
 * XSS-Free Visual Diagram Generator for Mermaid.js C4 Model and Structurizr DSL.
 * Strictly adheres to standard Mermaid C4 syntax (C4Context, C4Container, C4Component)
 * and OWASP LLM05: Output Handling.
 */

export interface DiagramOptions {
  level: number;
  format?: "mermaid" | "structurizr";
  title?: string;
  nodes?: Array<{
    id: string;
    label: string;
    desc?: string;
    type?: "person" | "system" | "container" | "component" | "external" | "database";
    technology?: string;
  }>;
  edges?: Array<{
    from: string;
    to: string;
    label?: string;
    technology?: string;
  }>;
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

  /**
   * Generates standard Mermaid.js C4 diagrams according to official Mermaid C4 syntax:
   * Level 1 -> C4Context
   * Level 2 -> C4Container
   * Level 3 -> C4Component
   */
  static renderC4Mermaid(options: DiagramOptions): string {
    const level = options.level || 2;
    const title = options.title || "System Architecture";
    const header = level === 1 ? "C4Context" : level === 3 ? "C4Component" : "C4Container";

    const lines: string[] = [header];
    lines.push(`    title ${this.escapeMermaidLabel(title)}`);
    lines.push("");

    const nodes = options.nodes || [];
    const internalNodes = nodes.filter((n) => n.type !== "external" && n.type !== "person");
    const externalNodes = nodes.filter((n) => n.type === "external" || n.type === "person");

    // Render external systems and actors outside boundary
    for (const n of externalNodes) {
      const safeId = this.sanitizeMermaidId(n.id);
      const label = this.escapeMermaidLabel(n.label);
      const desc = this.escapeMermaidLabel(n.desc || "");
      if (n.type === "person") {
        lines.push(`    Person(${safeId}, "${label}", "${desc}")`);
      } else {
        lines.push(`    System_Ext(${safeId}, "${label}", "${desc}")`);
      }
    }

    // Render container/system boundary for internal components
    if (internalNodes.length > 0) {
      const boundaryMacro = level === 1 ? "Enterprise_Boundary" : "Container_Boundary";
      lines.push(`    ${boundaryMacro}(b1, "${this.escapeMermaidLabel(title)}") {`);

      for (const n of internalNodes) {
        const safeId = this.sanitizeMermaidId(n.id);
        const label = this.escapeMermaidLabel(n.label);
        const desc = this.escapeMermaidLabel(n.desc || "");
        const tech = this.escapeMermaidLabel(n.technology || (n.type === "database" ? "SQLite WAL" : "Core Module"));

        if (level === 1) {
          lines.push(`        System(${safeId}, "${label}", "${desc}")`);
        } else if (level === 3) {
          lines.push(`        Component(${safeId}, "${label}", "${tech}", "${desc}")`);
        } else {
          if (n.type === "database") {
            lines.push(`        ContainerDb(${safeId}, "${label}", "${tech}", "${desc}")`);
          } else {
            lines.push(`        Container(${safeId}, "${label}", "${tech}", "${desc}")`);
          }
        }
      }

      lines.push("    }");
    }

    lines.push("");

    // Render relationships
    const edges = options.edges || [];
    for (const e of edges) {
      const safeFrom = this.sanitizeMermaidId(e.from);
      const safeTo = this.sanitizeMermaidId(e.to);
      const label = this.escapeMermaidLabel(e.label || "uses");
      const tech = e.technology ? `, "${this.escapeMermaidLabel(e.technology)}"` : "";
      lines.push(`    Rel(${safeFrom}, ${safeTo}, "${label}"${tech})`);
    }

    return lines.join("\n");
  }

  static renderC4ContextMermaid(
    title: string,
    nodes: Array<{ id: string; label: string; type?: string; description?: string; technology?: string }>,
    edges: Array<{ from: string; to: string; label?: string; technology?: string }>
  ): string {
    return this.renderC4Mermaid({
      level: 1,
      title,
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.label,
        desc: n.description,
        type: (n.type as any) || "system",
        technology: n.technology,
      })),
      edges,
    });
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
    return this.renderC4Mermaid(options);
  }

  private static renderStructurizr(options: DiagramOptions): string {
    const title = options.title || "AutoDoc Inspected System";
    const nodes = (options.nodes || []).map((n) => ({ ...n, description: n.desc }));
    return this.renderStructurizrDsl(title, nodes, options.edges || []);
  }
}
