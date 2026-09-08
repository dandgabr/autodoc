import { describe, it, expect } from "vitest";
import { DiagramRenderer } from "../src/diagrams/renderer.js";

describe("DiagramRenderer (XSS & Security Hardening)", () => {
  it("should escape dangerous characters to HTML entities in Mermaid labels", () => {
    const maliciousLabel = '<script>alert("pwned")</script> & "quotes" \'single\'';
    const escaped = DiagramRenderer.escapeMermaidLabel(maliciousLabel);

    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("</script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;");
  });

  it("should sanitize malicious node identifiers to safe alphanumeric strings", () => {
    const dirtyId = "node/with-special.chars@123::malicious!#";
    const sanitized = DiagramRenderer.sanitizeMermaidId(dirtyId);

    expect(sanitized).toMatch(/^[a-zA-Z0-9_]+$/);
    expect(sanitized).not.toContain("/");
    expect(sanitized).not.toContain("@");
    expect(sanitized).not.toContain("!");
  });

  it("should neutralize javascript: and data: pseudo-protocol URIs", () => {
    const dangerousUrl1 = "javascript:alert(1)";
    const dangerousUrl2 = "data:text/html,<script>alert(1)</script>";
    const safeUrl = "https://github.com/dandgabr/autodoc";

    expect(DiagramRenderer.sanitizeUri(dangerousUrl1)).toBe("#blocked");
    expect(DiagramRenderer.sanitizeUri(dangerousUrl2)).toBe("#blocked");
    expect(DiagramRenderer.sanitizeUri(safeUrl)).toBe(safeUrl);
  });

  it("should render a clean and safe C4 Model System Context diagram in Mermaid", () => {
    const nodes = [
      { id: "user", label: 'End User <script>', type: "person" as const, description: "System operator" },
      { id: "autodoc", label: 'AutoDoc Core & Engine', type: "system" as const, description: "Code intelligence engine" },
      { id: "github", label: "External Git Host", type: "external" as const, description: "Remote repository" }
    ];
    const edges = [
      { from: "user", to: "autodoc", label: "Queries code" },
      { from: "autodoc", to: "github", label: "Fetches commits" }
    ];

    const mermaid = DiagramRenderer.renderC4ContextMermaid("AutoDoc System", nodes, edges);
    expect(mermaid).toContain("flowchart TB");
    expect(mermaid).toContain("subgraph Boundary_System");
    expect(mermaid).not.toContain("<script>");
    expect(mermaid).toContain("&lt;script&gt;");
    expect(mermaid).toContain("user -->");
    expect(mermaid).toContain("autodoc -->");
  });

  it("should render valid Structurizr DSL without script injection", () => {
    const nodes = [
      { id: "cli_user", label: 'Operator "Root"', type: "person" as const, description: "Developer" },
      { id: "server", label: "Core Service", type: "system" as const, description: "Rust backend" }
    ];
    const edges = [
      { from: "cli_user", to: "server", label: 'Interacts with "API"' }
    ];

    const dsl = DiagramRenderer.renderStructurizrDsl("Enterprise Architecture", nodes, edges);
    expect(dsl).toContain('workspace "Enterprise Architecture"');
    expect(dsl).toContain('cli_user = person "Operator \\"Root\\""');
    expect(dsl).toContain('server = softwareSystem "Core Service"');
    expect(dsl).toContain('cli_user -> server');
  });
});
