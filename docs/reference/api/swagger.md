# Reference: REST API Contract & Swagger Specification

This document provides the REST API documentation for AutoDoc Code Explorer, exposing equivalent HTTP/JSON endpoints for AI agents and developer tooling.

The formal OpenAPI 3.1.0 specification is available in YAML format: [`docs/reference/api/openapi.yaml`](openapi.yaml).

---

## 1. Endpoints Overview

| Method | Endpoint | Summary | Tags |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/system/ping` | Health & FFI Latency Check | `System` |
| `POST` | `/api/v1/scan` | Trigger Repository Scan | `Scanner` |
| `POST` | `/api/v1/diagrams/c4` | Generate C4 Architectural Diagram | `Diagrams` |
| `GET` | `/api/v1/symbols/contract` | Extract AST Symbol Contract | `Symbols` |
| `POST` | `/api/v1/dataflow/trace` | Trace Taint Data Flow | `Analysis` |
| `GET` | `/api/v1/contracts` | Inventory Enterprise API Contracts | `Contracts` |
| `POST` | `/api/v1/adr` | Synthesize Architecture Decision Record | `Decisions` |
| `DELETE` | `/api/v1/cache` | Purge and Vacuum Local Cache | `Cache` |

---

## 2. Interactive Swagger UI & Integration

To view the interactive Swagger documentation locally or integrate with Redoc:

```bash
# Using swagger-ui-watcher or any standard OpenAPI viewer
npx swagger-ui-watcher docs/reference/api/openapi.yaml
```

Or consume the contract in Spotify Backstage via `catalog-info.yaml`:
```yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: autodoc-rest-api
  title: AutoDoc Code Explorer REST API
  description: Repository discovery, C4 diagramming, and symbol extraction API.
spec:
  type: openapi
  lifecycle: production
  owner: architecture-guild
  definition:
    $text: https://github.com/dandgabr/autodoc/blob/main/docs/reference/api/openapi.yaml
```

---

## 3. Error Standard (RFC 7807 / RFC 9457)

All error payloads follow a structured JSON schema:

```json
{
  "code": "AUTODOC_E101",
  "message": "Database initialization failure.",
  "details": {
    "path": ".autodoc/cache.db",
    "cause": "EACCES: permission denied"
  }
}
```
