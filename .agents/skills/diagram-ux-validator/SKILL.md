---
name: diagram-ux-validator
description: Validates user experience (UX), WCAG 2.1 AA visual contrast, text wrapping, and architectural consistency of Mermaid diagrams.
metadata:
  type: validation
  phase: documentation
---

# Diagram UX & Visual Contrast Validator Skill

This skill governs the visual design, accessibility, and user experience (UX) of architectural diagrams generated or maintained in the AutoDoc repository. It establishes normative standards to ensure diagrams remain legible, high-contrast, free of text clipping or overlap, and visually harmonious across light and dark client themes.

---

## 1. Core Principles of Diagram UX

1. **Strict Vertical Top-to-Bottom Flow**:
   - Architectural topology diagrams must flow strictly from top to bottom (`flowchart TD` or `direction TB`).
   - Standard Tier Hierarchy:
     - **Tier 1 (Top)**: User / Client Interfaces & AI Agent Harnesses.
     - **Tier 2 (Upper Middle)**: API Gateways, Protocol Servers, or MCP Host Applications.
     - **Tier 3 (Lower Middle)**: Core Business Logic, Compute Engines, or Native Libraries.
     - **Tier 4 (Bottom)**: Storage, Databases, Caches, or File Stores.
   - Horizontal (`LR` / Left-to-Right) layouts are forbidden for end-to-end system architectures because they cause awkward horizontal scrolling and cramped node text on mobile and split-view IDE panels.

2. **Guaranteed Visual Contrast (WCAG 2.1 AA)**:
   - All text within nodes must achieve a minimum contrast ratio of **4.5:1** against the node fill color.
   - Every node must feature an explicit, contrasting border (`stroke-width: 2px` minimum) to remain clearly discernible against both dark (`#0D1117`, `#161B22`) and light (`#FFFFFF`, `#F6F8FA`) canvas backgrounds.
   - Connector arrows must use high-visibility stroke colors (`stroke:#94A3B8` with `stroke-width:2px`).

3. **Text Overlap & Truncation Elimination**:
   - Mermaid renders text in SVG. Long unbreaking strings cause text overflow, clipped labels, or node collisions.
   - **Line Length Budget**: No individual line within a node label may exceed **45 characters** without an explicit `<br/>`.
   - **Structured Wrapping**: Use explicit HTML `<br/>` tags and `<small>` subtitle tags to group information logically:
     ```mermaid
     NodeId["🏷️ Primary Label<br/><small>Technology • Secondary Description</small>"]
     ```

4. **Semantic Color Palette**:
   To prevent visual noise and ensure consistency across documentation, all diagrams must use the following approved semantic classes:

   | Class Name | Target Concept | Fill (`fill`) | Border (`stroke`) | Text (`color`) |
   | :--- | :--- | :--- | :--- | :--- |
   | `clientClass` | Users, Engineers, External AI Agents | `#1E293B` | `#0EA5E9` (2px) | `#FFFFFF` (bold) |
   | `systemClass` | Primary System / Root Boundary | `#0F172A` | `#38BDF8` (2px) | `#FFFFFF` (bold) |
   | `mcpClass` / `tsComp` | Node.js / TypeScript Host Containers | `#1E1B4B` | `#818CF8` (2px) | `#FFFFFF` |
   | `rustClass` / `rustComp` | Rust Native Engines & Native Modules | `#311505` | `#FB923C` (2px) | `#FFFFFF` |
   | `dbClass` | SQLite, PostgreSQL, Persistent Caches | `#064E3B` | `#34D399` (2px) | `#FFFFFF` |
   | `glueClass` | FFI Boundaries, Type Interfaces, IPC | `#0F172A` | `#38BDF8` (2px) | `#FFFFFF` (bold) |

---

## 2. Diagram Review & Audit Checklist

When inspecting or creating any Mermaid diagram in `README.md` or `docs/`:

- [ ] **Directive Check**: Does the block begin with `flowchart TD` or declare `direction TB` in the root subgraph?
- [ ] **Class Definitions**: Are all nodes styled with explicit `classDef` rules or assigned via `:::className`?
- [ ] **Contrast Verification**: Does every node fill-to-text pairing meet the 4.5:1 ratio? Are borders at least 2px?
- [ ] **Line Length Check**: Are all label lines capped at 45 characters before an explicit `<br/>`?
- [ ] **Link Styling**: Does the diagram end with `linkStyle default stroke:#94A3B8,stroke-width:2px;`?
- [ ] **Special Character Escaping**: Are quotes, brackets, and ampersands properly formatted without breaking SVG rendering?

---

## 3. Automated Validation Reference

Automated audit of all repository diagrams can be executed via the diagram validation tool:
```bash
node .agents/skills/diagram-ux-validator/scripts/validate-diagrams.mjs
```
The script exits with code `0` when all diagrams meet compliance criteria, or outputs actionable line numbers and remediation tips upon violation.
