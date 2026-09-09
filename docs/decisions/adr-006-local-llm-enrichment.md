# ADR-006: Local LLM Enrichment with Hardware-Adaptive Model Profiles

> Mirrored from ai-memory `decisions/autodoc-local-llm-enrichment.md`.

## Status: Accepted (Pinned)

## Context
AutoDoc relied exclusively on regex/AST heuristics. The operator wanted a local LLM (≤5 GB VRAM/RAM) integrated across all functions (detection, OpenAPI contracts, C4 diagrams, ADRs, documentation) without depending only on regex.

## Decision
1. **Three model profiles** (all Q4_K_M GGUF): `small` = Qwen2.5-Coder-3B (~3 GB, default), `mid` = gemma-3-4b-it (~4 GB, 128k context), `large` = Qwen2.5-Coder-7B (~5.5 GB). Selection: operator override (env `AUTODOC_LLM_MODEL`/`AUTODOC_LLM_PROFILE` or per-call `model_profile`) > auto-selection (largest profile fitting min(free VRAM, free RAM) with 15% safety margin) > deterministic fallback.
2. **Hardware detection** (`llm/hardware.ts`): `nvidia-smi`/`rocm-smi` VRAM probe + `os.freemem`; classifies host and picks profile.
3. **Providers** (`llm/factory.ts`): node-llama-cpp in-process (lazy optional import, never hard dep) and llama.cpp `llama-server` HTTP (OpenAI-compatible, via `AUTODOC_LLM_SERVER_URL`).
4. **Structured output** (`llm/structured.ts`): `generateJson` — JSON-shape system prompt, parse + Zod validation, 1 repair retry with error feedback; unparseable results never accepted.
5. **Two-pass hybrid detection** (`analyzers/llm-candidate-filter.ts`): pass-1 regex remains source of truth; only ambiguous candidates (e.g. routes without resolved mount prefix) go to pass-2 LLM validation; LLM failure keeps pass-1 results (`llmEnriched: false`).
6. **Anti-hallucination**: OpenAPI structure stays deterministic; LLM only writes summaries/descriptions/refinements validated against static evidence.
7. **New tool `autodoc_llm_status`** (11th tool): hardware, auto-profile, active model, per-profile local weights and availability. Tools accepting `model_profile`/`llm_enrich`: export_openapi, get_c4_diagram, generate_adr, list_api_contracts (two-pass pruning), llm_status.
8. Docs at `docs/how-to/local-llm-enrichment.md`.

## Consequences
- Verified: hardware detection works on the dev host (CUDA, 5.5 GB free VRAM → auto-selects `large`); graceful no-model fallback (`llmEnrichedAvailable: false`).
- Full pipeline active only after `npm install node-llama-cpp` + GGUF download; otherwise all behavior unchanged (regex-only).
- Tool count is now 11; tests updated (50/50 passing).

## Live validation amendments (2026-09-08)

The pipeline was built, compiled and exercised end-to-end against the AutoDoc repository itself (`qwen2.5-coder-3b-instruct-q4_k_m.gguf`, 2.1 GB, in `.autodoc/models/`, via `node-llama-cpp` with a from-source llama.cpp build; Vulkan build failed for missing `glslc`, so inference ran on CPU):

1. All four LLM entrypoints verified live: `autodoc_export_openapi` (LLM summaries, `llmEnriched: true`), `autodoc_generate_adr` (full MADR synthesis), `autodoc_get_c4_diagram` (refined node descriptions), `autodoc_llm_status` (model loaded, 16k context, cpu device).
2. **Structured-prompt fix** (`llm/structured.ts`): the system prompt now states the exact JSON keys ("must have exactly these keys: ...") instead of echoing an opaque Zod `_def`; the retry prompt restates the keys. This fixed a real failure mode where the model answered in markdown prose instead of JSON.
3. **Array coercion for small-model outputs**: ADR `consequences` accepts string OR array-of-strings (union + transform); C4 `descriptions` accepts either a list or an `{id: description}` map, normalized in the schema transform. Small models frequently emit lists where a string is expected.
4. Measured CPU performance: model load ~2.4 s; JSON generation ~9–20 s; full enriched calls 19–64 s (~6–15 tok/s). GPU acceleration requires a CUDA toolchain or `glslc` (Vulkan SDK); without it, node-llama-cpp falls back to CPU.
5. Deterministic fallback re-verified: with `llm_enrich` unset or on LLM failure, every tool returns regex-only results unchanged; 50/50 tests passing after the fixes.
6. Execution record: ai-memory `notes/llm-pipeline-live-validation.md`.

## GPU acceleration amendments (2026-09-09)

1. **Vendor-agnostic backend detection** (`llm/hardware.ts`): probes every GPU stack independently — CUDA/NVIDIA (`nvidia-smi`), ROCm/AMD (`rocm-smi`), Intel oneAPI SYCL (`sycl-ls`), Vulkan (`vulkaninfo --summary`, excluding software renderers), Metal (`powermetrics`) — and selects the highest-priority backend the runtime can use, with CPU fallback. `detectedVia` records every probed source.
2. **Vulkan backend live on RTX 3060**: `glslc` (dnf shaderc) + vendored SPIRV-Headers (llama.cpp needs a CMake CONFIG package missing from distro packages; clone KhronosGroup/SPIRV-Headers, `cmake --install` to a prefix, set `CMAKE_PREFIX_PATH`). Patched `ggml-vulkan/CMakeLists.txt` to link `SPIRV-Headers::SPIRV-Headers` (missing include propagation caused `spirv/unified1/spirv.hpp: No such file`).
3. **CUDA backend live on GCC 16 hosts**: nvcc 13.3 rejects GCC > 15; resolved without root via `--allow-unsupported-compiler`. `factory.ts` exports `$CUDA_PATH/bin` onto `PATH` and, when `AUTODOC_CUDA_ALLOW_UNSUPPORTED_COMPILER=1`, sets `NODE_LLAMA_CPP_CMAKE_OPTION_CMAKE_CUDA_FLAGS=--allow-unsupported-compiler` on `process.env` (consumed by node-llama-cpp's `customCmakeOptionsEnvVarPrefix` mechanism). The alternative with root is `dnf install gcc15 gcc15-c++` + `CUDA_HOST_COMPILER=/usr/bin/gcc15`.
4. **Measured performance** (enriched ADR call, Qwen2.5-Coder-3B Q4_K_M): CPU ~63 s → Vulkan ~13–15 s → **CUDA ~12 s** (~5x vs CPU). Both CUDA and Vulkan addons built and functional; runtime resolution order follows node-llama-cpp's build detection, with automatic fallback between backends.
5. Backend semantics: `hardware.device` reports the best detection priority (cuda when nvidia-smi exists); `activeModel.device` in `autodoc_llm_status` reports the backend node-llama-cpp actually loaded.
6. Execution records: ai-memory `notes/gpu-acceleration-live.md`, `notes/cuda-gcc16-resolution.md`.