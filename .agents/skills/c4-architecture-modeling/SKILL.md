---
name: c4-architecture-modeling
description: Standards for modeling and rendering software architecture using Simon Brown's C4 Model and standard Mermaid.js C4 syntax.
metadata:
  type: modeling
  phase: design
---

# C4 Architecture Modeling Skill

This skill defines the technical standards for visual software architecture documentation based on the **C4 Model** (Context, Containers, Components, Code) using official **Mermaid.js C4 syntax**.

---

## 1. Abstraction Levels

1. **Level 1: System Context (`C4Context`)**:
   - Focus: System scope, human users/personas, external third-party software, and high-level boundaries.
2. **Level 2: Containers (`C4Container`)**:
   - Focus: Separately deployable executable units (APIs, workers, web applications, databases, file stores).
3. **Level 3: Components (`C4Component`)**:
   - Focus: Modular groupings within a single container (controllers, repositories, services, analyzers).
   - AutoDoc dynamically derives Level 3 components directly from SQLite WAL `symbols` and `edges`, weighting high cyclomatic complexity ($CC$) modules and rendering actual internal call relationships.
4. **Level 4: Code (`C4Code` / Class Diagrams)**:
   - Focus: In-depth code relationships, interfaces, and design patterns.

---

## 2. Standard Mermaid.js C4 Syntax Rules

All architectural diagrams must use standard Mermaid C4 directives:

### System Context Example (Level 1)
```mermaid
C4Context
    title System Context Diagram

    Person(user, "User", "Interacts with the client application.")
    System(app, "Core System", "Primary application service.")
    System_Ext(external_api, "Third-Party API", "External data provider.")

    Rel(user, app, "Uses", "HTTPS")
    Rel(app, external_api, "Fetches data", "REST / JSON")
```

### Container Diagram Example (Level 2)
```mermaid
C4Container
    title Container Architecture Diagram

    Person(developer, "Developer", "Submits requests via IDE.")

    Container_Boundary(b1, "System Boundary") {
        Container(api, "API Service", "TypeScript", "Handles incoming JSON-RPC calls.")
        Container(engine, "Core Engine", "Rust", "Processes compute-intensive operations.")
        ContainerDb(db, "Database", "SQLite WAL", "Persists indices and graph edges.")
    }

    Rel(developer, api, "Invokes tools", "stdio")
    Rel(api, engine, "Dispatches tasks", "Node-API FFI")
    Rel(engine, db, "Reads & writes", "SQL / r2d2")
```

---

## 3. Diagram Quality Checklist

1. **Explicit Roles & Types**: Every element must define an identifier, a descriptive label, and its role.
2. **Documented Technologies**: Container and component elements must declare their primary runtime or language.
3. **Action-Oriented Relationships**: Every `Rel()` directive must state a descriptive action verb and the transport protocol.
