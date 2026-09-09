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

### 3. GPU acceleration (recommended)

Inference automatically prefers the fastest GPU backend available on the host, falling back to CPU:

| Priority | Backend | Requires | Detection |
|---|---|---|---|
| 1 | **CUDA / NVIDIA** | CUDA toolkit (`nvcc`) + GCC ≤ 15 (nvcc constraint) | `nvidia-smi` |
| 2 | **ROCm / AMD** | ROCm toolkit (`rocm-smi`, `hipcc`) | `rocm-smi` |
| 3 | **Intel oneAPI SYCL** | oneAPI base toolkit (`sycl-ls` showing GPU devices) | `sycl-ls` |
| 4 | **Vulkan** | `glslc` (shaderc) + `vulkaninfo` with a real GPU | `vulkaninfo --summary` |
| 5 | **Metal** | macOS native | `powermetrics` |
| — | **CPU fallback** | none | no GPU detected |

Detection probes every stack independently (a host may expose several, e.g. NVIDIA CUDA + Vulkan + Intel iGPU). The reported `device` field reflects the highest-priority backend; the actual backend used by `node-llama-cpp` is shown in `autodoc_llm_status` under `activeModel.device`.

**Fedora host notes (RTX 3060 example)**:

```bash
# Vulkan path (lightweight, no CUDA toolkit needed)
sudo dnf install glslc  # shaderc compiler for Vulkan shaders
# llama.cpp needs SPIRV-Headers with a CMake config; if the distro package
# is too old, vendor it locally and rebuild:
git clone --depth 1 https://github.com/KhronosGroup/SPIRV-Headers.git /tmp/spirv
cmake -S /tmp/spirv -B /tmp/spirv/build -DCMAKE_INSTALL_PREFIX=/tmp/spirv/prefix
cmake --install /tmp/spirv/build
export CMAKE_PREFIX_PATH=/tmp/spirv/prefix

# Trigger the GPU build (downloads llama.cpp and compiles with Vulkan):
node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu vulkan
```

CUDA builds require GCC ≤ 15; on hosts with newer GCC (e.g. Fedora 44 ships GCC 16), install an older compiler toolchain or use the Vulkan path.

### 4. Environment variables

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