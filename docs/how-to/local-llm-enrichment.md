# Local LLM Enrichment for AutoDoc

AutoDoc can augment its deterministic (regex/AST) analysis with a **local LLM** for richer contract inference, descriptions, diagram refinement and ADR synthesis. The LLM is strictly an enhancement — every tool degrades to deterministic behavior when no model is available.

## Model profiles (≤ 5 GB budget)

| Profile | Model | Quantization | Total budget | Context | License |
|---|---|---|---|---|---|
| `small` | Qwen2.5-Coder-3B-Instruct | Q4_K_M | ~3 GB | 32k | Apache-2.0 |
| `mid` | gemma-3-4b-it | Q4_K_M | ~4 GB | 128k | Gemma Terms |
| `large` | Qwen2.5-Coder-7B-Instruct | Q4_K_M | ~5.5 GB | 32k | Apache-2.0 |

**Auto-selection**: the largest profile that fits the host budget (min of free VRAM and free RAM, 15% safety margin) is chosen automatically. Operator override always wins.

## Setup

### 1. Download a model (GGUF, Q4_K_M)

```bash
mkdir -p .autodoc/models
# Option A: huggingface-cli (any profile)
huggingface-cli download Qwen/Qwen2.5-Coder-3B-Instruct-GGUF \
  qwen2.5-coder-3b-instruct-q4-k-m.gguf --local-dir .autodoc/models
# Or point AUTODOC_LLM_MODEL at any GGUF path.
```

Search order for local weights: `$AUTODOC_LLM_MODELS_DIR` → `./.autodoc/models` → `~/.autodoc/models` → `$HF_HOME/hub`.

### 2. Choose an adapter

- **node-llama-cpp** (default, in-process): `npm install node-llama-cpp` in `packages/autodoc-mcp`. Loaded lazily; if absent, the `llama-server` adapter is used.
- **llama-server** (external, llama.cpp): start `llama-server -m <gguf> --port 8080` and set `AUTODOC_LLM_SERVER_URL=http://127.0.0.1:8080`.

### 3. Environment variables

| Variable | Purpose |
|---|---|
| `AUTODOC_LLM_MODEL` | Explicit GGUF path (highest override). |
| `AUTODOC_LLM_PROFILE` | `small` \| `mid` \| `large` \| `auto`. |
| `AUTODOC_LLM_SERVER_URL` | Use the external llama-server adapter. |
| `AUTODOC_LLM_MODELS_DIR` | Extra directory scanned for weights. |
| `AUTODOC_LLM_TIMEOUT_MS` | Generation timeout (default 120000). |

## Per-tool control

Every LLM-aware tool accepts `model_profile` (`small|mid|large|auto`) and `llm_enrich` (boolean):

- `autodoc_llm_status` — hardware, auto-selected profile, active model, availability.
- `autodoc_export_openapi` — `llm_enrich: true` adds LLM-written summaries/descriptions (structure remains deterministic).
- `autodoc_get_c4_diagram` — `llm_enrich: true` refines node descriptions.
- `autodoc_generate_adr` — `llm_enrich: true` synthesizes Context/Decision/Consequences.
- `autodoc_list_api_contracts` / analyzers — two-pass hybrid when `llmEnrichment` is enabled in code.

## Guarantees

- **Deterministic fallback**: no model/timeout/parse failure → regex-only results with `llmEnriched: false`.
- **Anti-hallucination**: OpenAPI structure (paths, methods, params, $refs) comes only from static analysis; the LLM writes descriptions/refinements validated against evidence, with structured-output JSON validation and one repair retry.
- **Structured output**: JSON schema-constrained decoding at generation level.