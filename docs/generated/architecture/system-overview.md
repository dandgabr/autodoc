# Architecture Overview: autodoc

## 1. System Context (C4 Level 1)
```mermaid
C4Context
    title autodoc - C4 Level 1: System Context

    Person(UserActor, "End User / Player", "Uses web client interface to interact with the application")
    Enterprise_Boundary(b1, "autodoc - C4 Level 1: System Context") {
        System(SystemApp, "autodoc Platform", "AutoDoc Code Explorer MCP Server — Intelligent Codebase Mapping and Architecture Documentation")
    }

    Rel(UserActor, SystemApp, "Interacts via HTTPS &amp; WebSockets", "Browser / TLS")
```

## 2. Container Architecture (C4 Level 2)
```mermaid
C4Container
    title autodoc - C4 Level 2: Container Architecture

    Person(UserActor, "User", "End user utilizing the application")
    Container_Boundary(b1, "autodoc - C4 Level 2: Container Architecture") {
        Container(ApiGateway, "API &amp; Realtime Gateway", "Node.js / Express / REST", "Handles HTTP REST endpoints, WebSocket event loops, and authorization")
    }

    Rel(UserActor, ApiGateway, "Sends HTTP / WebSocket traffic", "TLS / HTTPS")
```

## 3. Technology Stack Summary
- **Core Application**: autodoc
- **Data Persistence**: MongoDB / Relational Storage Engine
- **Communication Protocols**: HTTP REST & Real-time WebSockets / WebRTC