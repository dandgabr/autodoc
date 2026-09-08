---
name: code-documentation-engineering
description: Technical documentation engineering skill enforcing the Diátaxis documentation framework, clear human prose, and code-comment synchronization.
metadata:
  type: documentation
  phase: design
---

# Code Documentation Engineering Skill

This skill guides agents in authoring software documentation adhering to the **Diátaxis documentation framework** and professional technical communication standards.

---

## 1. Information Architecture: The Diátaxis Framework

All documentation files must align with one of the four distinct quadrants:

```
               LEARNING (Acquisition)        WORKING (Application)
             ┌─────────────────────────────┬─────────────────────────────┐
PRACTICAL    │ 1. TUTORIALS                │ 2. HOW-TO GUIDES            │
(Action)     │ Learning-oriented lessons   │ Task-oriented procedures    │
             ├─────────────────────────────┼─────────────────────────────┤
THEORETICAL  │ 4. EXPLANATION              │ 3. REFERENCE                │
(Cognition)  │ Understanding concepts      │ Technical specifications    │
             └─────────────────────────────┴─────────────────────────────┘
```

### 1. Tutorials (`docs/tutorials/`)
- **Focus**: Guide beginners to an initial working milestone.
- **Tone**: Encouraging, direct, and structured step-by-step.
- **Rule**: Avoid theoretical digressions; provide clear inputs and expected outputs.

### 2. How-To Guides (`docs/how-to/`)
- **Focus**: Resolve a specific, practical problem encountered during development.
- **Tone**: Procedural and concise.
- **Rule**: Presuppose user familiarity with fundamentals; focus directly on the recipe.

### 3. Reference (`docs/reference/`)
- **Focus**: Exact, neutral, and comprehensive description of machines, APIs, and schemas.
- **Tone**: Descriptive and neutral.
- **Rule**: Organize logically (alphabetical, hierarchical) with complete parameter tables and error codes.

### 4. Explanation (`docs/explanation/`)
- **Focus**: Architecture context, design rationale, historical trade-offs, and design alternatives.
- **Tone**: Analytical and objective.
- **Rule**: Explain *why* a design choice was adopted rather than *how* to use it.

---

## 2. Technical Prose Standards

1. **Active Voice & Direct Imperatives**:
   - Write *"Run the test suite"* instead of *"The test suite should be executed"*.
2. **Clear Technical Precision**:
   - State concrete quantities, benchmarks, and latency targets instead of vague qualifiers.
   - Example: *"Reduces resident set size below 100MB"* instead of *"Offers superior memory optimization"*.
3. **Rhythm and Sentence Structure**:
   - Pair brief, punchy statements with detailed, well-punctuated compound sentences for readability.
4. **Code & Inline Synchronization**:
   - Ensure documented parameter names, default values, and function signatures strictly match source code.
