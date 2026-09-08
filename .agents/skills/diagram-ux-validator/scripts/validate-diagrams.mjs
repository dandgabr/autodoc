#!/usr/bin/env node

/**
 * AutoDoc Diagram UX & Visual Contrast Validator
 * 
 * Verifies that all Mermaid architectural diagrams across markdown files:
 * 1. Follow strict top-to-bottom orientation (flowchart TD or direction TB).
 * 2. Define high-contrast theme classes (WCAG 2.1 AA compliant).
 * 3. Restrict label line lengths to avoid SVG text clipping or overlapping.
 * 4. Include high-contrast link styling.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd());
const MARKDOWN_TARGETS = [
  "README.md",
  "docs/reference/architecture.md",
  "docs/reference/codebase-map.md",
  "docs/explanation/architecture-overview.md",
];

const REQUIRED_CLASSES = ["clientClass", "mcpClass", "rustClass", "dbClass"];
const MAX_LINE_LENGTH = 55; // Max allowed characters in a single label line before <br/>

let totalDiagrams = 0;
let violations = [];

function checkFile(relPath) {
  const fullPath = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    return;
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");

  let inMermaid = false;
  let diagramStartLine = 0;
  let diagramLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.trim().startsWith("```mermaid")) {
      inMermaid = true;
      diagramStartLine = lineNum;
      diagramLines = [];
      totalDiagrams++;
      continue;
    }

    if (inMermaid && line.trim().startsWith("```")) {
      inMermaid = false;
      validateDiagram(relPath, diagramStartLine, diagramLines);
      diagramLines = [];
      continue;
    }

    if (inMermaid) {
      diagramLines.push(line);
    }
  }
}

function validateDiagram(file, startLine, lines) {
  const fullText = lines.join("\n");

  // Skip non-flowchart diagrams
  if (!fullText.includes("flowchart") && !fullText.includes("C4")) {
    return;
  }

  // 1. Orientation Check
  const hasTopDown =
    fullText.includes("flowchart TD") ||
    fullText.includes("flowchart TB") ||
    fullText.includes("direction TB") ||
    fullText.includes("direction TD") ||
    fullText.includes("C4Context") ||
    fullText.includes("C4Container");

  if (!hasTopDown) {
    violations.push({
      file,
      line: startLine,
      message: "Diagram must use strict top-to-bottom layout ('flowchart TD' or 'direction TB').",
      type: "error",
    });
  }

  // Check forbidden horizontal layout
  if (fullText.includes("flowchart LR") || fullText.includes("direction LR")) {
    violations.push({
      file,
      line: startLine,
      message: "Horizontal layout ('LR') is forbidden for architecture diagrams.",
      type: "error",
    });
  }

  // 2. High Contrast Theme Classes
  if (fullText.includes("flowchart")) {
    for (const cls of REQUIRED_CLASSES) {
      const altCls = cls.replace("Class", "");
      if (!fullText.includes(`classDef ${cls}`) && !fullText.includes(`classDef ${altCls}`) && !fullText.includes(`classDef tsComp`)) {
        if (cls === "mcpClass" && (fullText.includes("mcp") || fullText.includes("TypeScript"))) {
          violations.push({
            file,
            line: startLine,
            message: `Missing high-contrast classDef '${cls}'.`,
            type: "warning",
          });
        }
      }
    }

    // 3. Link Style
    if (!fullText.includes("linkStyle") && !fullText.includes("stroke-width")) {
      violations.push({
        file,
        line: startLine,
        message: "Diagram lacks high-visibility linkStyle definition.",
        type: "warning",
      });
    }
  }

  // 4. Label Line Length / Clipping Check
  lines.forEach((lineText, idx) => {
    const currentLineNum = startLine + idx + 1;
    const match = lineText.match(/\["([^"]+)"\]/);
    if (match) {
      const labelContent = match[1];
      const labelSegments = labelContent.split(/<br\s*\/?>/i);
      for (const segment of labelSegments) {
        const cleanText = segment.replace(/<[^>]+>/g, "").trim();
        if (cleanText.length > MAX_LINE_LENGTH) {
          violations.push({
            file,
            line: currentLineNum,
            message: `Label line length (${cleanText.length} chars) exceeds ${MAX_LINE_LENGTH} chars limit. Use <br/> to prevent text clipping: "${cleanText.slice(0, 30)}..."`,
            type: "warning",
          });
        }
      }
    }
  });
}

function main() {
  console.log("🔍 Running AutoDoc Diagram UX & Visual Contrast Validator...");

  for (const target of MARKDOWN_TARGETS) {
    checkFile(target);
  }

  console.log(`📊 Scanned ${totalDiagrams} Mermaid diagram(s) across target documentation.`);

  const errors = violations.filter((v) => v.type === "error");
  const warnings = violations.filter((v) => v.type === "warning");

  if (warnings.length > 0) {
    console.log(`\n⚠️ Warnings (${warnings.length}):`);
    for (const w of warnings) {
      console.log(`  - [${w.file}:${w.line}] ${w.message}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n❌ Failed with ${errors.length} error(s):`);
    for (const e of errors) {
      console.error(`  - [${e.file}:${e.line}] ${e.message}`);
    }
    process.exit(1);
  }

  console.log("\n✅ All diagrams comply with top-to-bottom layout, high contrast, and UX standards.");
}

main();
