# ADR-003b: Agnostic Workspace, Multi-Container and Modular Architecture Discovery Engine

> Mirrored from ai-memory `decisions/autodoc-agnostic-discovery-engine.md`.

## Status: Accepted (Pinned)

## Context
During the benchmark evaluation against the `butecogames` monorepo, AutoDoc exhibited critical coverage gaps:
1. Fatal scoping issue in handlers relying on `process.cwd()` instead of target repository path.
2. Shallow directory traversal capped at depth 5, cutting off nested monorepo packages and modules.
3. Inversion-of-control blindness: ignoring plugin registrations and route prefix mounts (`app.use('/prefix', router)`, `registerServerModule`).
4. Realtime socket blindness: only inspecting top-level TypeScript interfaces while missing Shared Room Runtime lifecycles (`core/rooms/`) and imperative emissions.
5. Polymorphic schema omission: missing Mongoose discriminators (`registerMatchDiscriminator`, `model.discriminator`), compound indexes, and soft-delete plugins.
6. Monorepo and container narrowness: defaulting only to npm and basic Docker rather than pnpm, Cargo, go.work, Poetry, Podman Quadlets, Kubernetes, Helm, and Nomad.

## Decision
1. **Universal Target Repository Resolution**: Standardized `repository_path` / `repoPath` parameters across all MCP tool schemas with persistent session state caching.
2. **WorkspaceAnalyzer**: Comprehensive tool-agnostic detection of workspaces and package managers across Node (pnpm, npm, yarn, bun), Rust (Cargo), Go (go.work), Python (Poetry, pip), JVM (Maven, Gradle), .NET, Composer, and Bundler.
3. **ContainerInfraAnalyzer**: Multi-orchestration container discovery covering Docker Compose, Podman Compose, Podman Quadlets (`*.container`, `*.kube`), Kubernetes manifests, Helm charts, Nomad job specs, and Devcontainers.
4. **IoC & Modular REST Route Engine**: Two-pass router discovery resolving prefix mounts, sub-routers, and plugin registry declarations.
5. **Universal Realtime Engine**: Bidirectional event inventorying covering typed contracts, Shared Room Runtime lifecycles (`room:join`, `room:ready`, etc.), module declarations, and WebRTC SFU.
6. **Polymorphic Persistence Engine**: Mongoose discriminators, compound indexes, soft-delete plugins, Prisma, SQLAlchemy STI, JPA, and EF Core.
7. **Living Diátaxis Synthesis**: Generates 20+ documentation artifacts including tailored getting-started guides, boundary test how-tos, and per-module catalogs.

## Consequences
- 100% test coverage across 49 unit and integration tests.
- High-fidelity discovery on complex enterprise monorepos (discovering >160 routes, >200 socket events, >70 models on Buteco Games).
- Fully tool-agnostic, language-agnostic, and container-agnostic.