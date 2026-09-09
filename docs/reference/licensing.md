# Reference: Open-Source Licensing and Compliance

AutoDoc is licensed under the permissive **MIT License**.

---

## License Compliance Policy

AutoDoc enforces a zero-copyleft policy to permit unrestricted personal, academic, and commercial use.

### Permitted Licenses
The following open-source licenses are explicitly approved in `.cargo-deny.toml` and root `package.json`:
- `MIT`
- `Apache-2.0` (with LLVM Exception)
- `BSD-2-Clause` / `BSD-3-Clause`
- `ISC`
- `0BSD`
- `CC0-1.0`
- `Unlicense`
- `Python-2.0`
- `BlueOak-1.0.0`
- `CC-BY-3.0`
- `Zlib`

### Prohibited Licenses
The following license families are strictly banned across all crates and packages:
- `GPL-1.0` / `GPL-2.0` / `GPL-3.0`
- `AGPL-1.0` / `AGPL-3.0`
- `LGPL-2.0` / `LGPL-2.1` / `LGPL-3.0`
- `SSPL`
- Any license containing non-commercial or source-disclosure requirements.

---

## Automated Verification

Licensing gates run locally and in pipelines:

```bash
# Check Rust crate dependency licenses
cargo-deny --config .cargo-deny.toml check licenses bans

# Check Node.js npm dependency licenses
npm run check:licenses
```

---

## Local LLM Stack Licensing (ADR-006)

AutoDoc's optional local LLM enrichment adds a runtime dependency on a model-inference stack. License status, considering that AutoDoc is a **developer/pipeline tool consumed as-is (not embedded as a library in redistributed products)**:

| Component | License | Commercial/private use | Notes |
|---|---|---|---|
| `node-llama-cpp` (npm) | MIT | ✅ Unrestricted | JS bindings; pulls `llama/llama.cpp` at install |
| `llama.cpp` (vendored into node-llama-cpp) | **MIT** ("The ggml authors") as of the `node-llama-cpp@3.20.0` pin | ✅ Unrestricted | Upstream llama.cpp has migrated parts to GPL-3.0 since late 2024; **any version bump of node-llama-cpp must re-verify the vendored LICENSE** |
| Qwen2.5-Coder GGUF weights (small/large profiles) | Apache-2.0 | ✅ Unrestricted | Redistributable with NOTICE |
| gemma-3-4b-it GGUF weights (mid profile) | Google Gemma Terms of Use (custom, not OSI) | ✅ Allowed for commercial/private use | **Weights are not freely redistributable** — download them per-host via `scripts/setup-llm.sh`; do not bundle into artifacts |
| Vulkan/CUDA/ROCm toolchains | Vendor SDK licenses | ✅ Runtime-only, not distributed | Not shipped with AutoDoc |

**Compliance policy for this stack:**

1. **No GPL gate needed today.** The zero-copyleft rule above applies to AutoDoc's own dependency tree as shipped; the vendored llama.cpp copy pinned by node-llama-cpp 3.20.0 is MIT. Because AutoDoc is used as a tool (not embedded), even a future GPL llama.cpp would only be an issue if someone redistributed an AutoDoc bundle containing it.
2. **Version-bump guard (recommended):** after upgrading `node-llama-cpp`, check `node_modules/node-llama-cpp/llama/llama.cpp/LICENSE` for GPL text before accepting the bump:
   ```bash
   grep -qiE "GNU General Public License" node_modules/node-llama-cpp/llama/llama.cpp/LICENSE && echo "GPL detected — review before upgrading" || echo "MIT — safe"
   ```
3. **Do not redistribute GGUF weights** (especially Gemma) inside release artifacts; users fetch them per-host via the setup script.
4. `cargo-deny` and `check:licenses` cover the Rust and npm trees respectively; the vendored llama.cpp copy is covered by the manual check above (the npm license field reports MIT and does not reflect the vendored directory).
