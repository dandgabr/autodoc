# GPU Setup for Local LLM Enrichment (Windows / Linux / macOS)

This guide covers enabling GPU acceleration for AutoDoc's local LLM enrichment on any operating system. If you want the fastest path, run the automated setup script first and only fall back to this guide if something fails.

## Quick start (automated)

```bash
# Linux / macOS
./scripts/setup-llm.sh                      # auto-detect GPU, install deps, build best backend
./scripts/setup-llm.sh --profile large      # pick a bigger model
./scripts/setup-llm.sh --backend vulkan     # force a specific backend
```

```powershell
# Windows (PowerShell)
.\scripts\setup-llm.ps1
.\scripts\setup-llm.ps1 -Profile large -Backend cuda
```

The script: detects your GPU vendor, installs missing toolchains via your system package manager (sudo/admin may be requested), vendors SPIRV-Headers when needed, downloads the model, and builds the best backend. When it finishes, `autodoc_llm_status` should report `device: cuda` / `vulkan` / `metal` instead of `cpu`.

Nothing here is mandatory: without any GPU toolchain, AutoDoc runs on CPU with identical behavior.

## Backend priority

| Priority | Backend | Vendor |
|---|---|---|
| 1 | CUDA | NVIDIA (all modern GPUs) |
| 2 | ROCm / HIP | AMD (RX 6000+, supported cards) |
| 3 | oneAPI SYCL | Intel (Arc, Iris Xe) and NVIDIA via plugin |
| 4 | Vulkan | Universal: NVIDIA, AMD, Intel iGPU/discrete |
| 5 | Metal | Apple Silicon and Apple GPUs (macOS only) |
| — | CPU fallback | Any host |

AutoDoc probes all stacks independently and selects the highest-priority one that the runtime can actually load. Check what was selected with `autodoc_llm_status` (`activeModel.device` is the backend in use).

## Linux

### CUDA / NVIDIA

1. Install the NVIDIA proprietary driver (via your distro's driver manager or packages).
2. Install the CUDA toolkit:
   - Ubuntu/Debian: follow https://developer.nvidia.com/cuda-downloads (network repo recommended).
   - Fedora/RHEL: `sudo dnf install cuda` from the NVIDIA CUDA repository, or use the runfile installer.
   - Arch: `sudo pacman -S cuda`.
3. Ensure `nvcc` is on `PATH` (`/usr/local/cuda/bin`).
4. **GCC compatibility**: each CUDA release supports GCC up to a specific major version (CUDA 13.x → GCC ≤ 15). If your system GCC is newer:
   - **Without root** (AutoDoc handles this): set `AUTODOC_CUDA_ALLOW_UNSUPPORTED_COMPILER=1`. AutoDoc passes `--allow-unsupported-compiler` to the build.
   - **With root**: install an older GCC side-by-side and point to it:
     ```bash
     sudo dnf install -y gcc15 gcc15-c++        # Fedora
     export CUDA_HOST_COMPILER=/usr/bin/gcc15
     ```
5. Build: `node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu cuda`

### ROCm / AMD

1. Install ROCm: https://rocm.docs.amd.com/projects/install-on-linux (select your distro; requires a supported card).
2. Add yourself to the `render` and `video` groups: `sudo usermod -aG render,video $USER` (re-login required).
3. Verify: `rocm-smi` and `hipcc --version`.
4. Build: `node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu cuda` (llama.cpp uses ROCm through the HIP/BLAS path; set `GGML_HIPBLAS=1` if the build does not detect it).

### Intel oneAPI SYCL

1. Install the Intel oneAPI Base Toolkit: https://www.intel.com/content/www/us/en/developer/tools/oneapi/base-toolkit-download.html
2. Source the environment: `source /opt/intel/oneapi/setvars.sh`
3. Verify GPU devices appear: `sycl-ls` (look for `[sycl:gpu]` entries).
4. Install the required GPU drivers: Intel GPU compute runtime (Level Zero + OpenCL) — see https://github.com/intel/compute-runtime
5. Build: `GGML_SYCL=1 node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu auto`

### Vulkan (universal fallback, any vendor)

Works on NVIDIA, AMD and Intel GPUs — the lightest path when CUDA/ROCm/SYCL are not options:

1. Install the toolchain:
   - Debian/Ubuntu: `sudo apt install glslc vulkan-tools mesa-vulkan-drivers` (NVIDIA users: also the NVIDIA Vulkan driver, bundled with the proprietary driver).
   - Fedora: `sudo dnf install glslc vulkan-headers mesa-vulkan-drivers` (NVIDIA: proprietary driver includes Vulkan).
   - Arch: `sudo pacman -S shaderc vulkan-headers vulkan-tools`.
2. Verify: `vulkaninfo --summary` should list your GPU (not just `llvmpipe`, which is a software renderer and will be ignored).
3. **SPIRV-Headers**: llama.cpp requires SPIRV-Headers with a CMake CONFIG module. Many distros ship it without the config or in an older version. The setup script vendors it automatically; manually:
   ```bash
   git clone --depth 1 https://github.com/KhronosGroup/SPIRV-Headers.git ~/.autodoc/spirv-headers/src
   cmake -S ~/.autodoc/spirv-headers/src -B ~/.autodoc/spirv-headers/build -DCMAKE_INSTALL_PREFIX=~/.autodoc/spirv-headers/prefix
   cmake --install ~/.autodoc/spirv-headers/build
   export CMAKE_PREFIX_PATH=~/.autodoc/spirv-headers/prefix
   ```
4. Build: `node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu vulkan`

## macOS

Metal is native — no extra toolchain:

```bash
node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu metal
```

Requires Xcode Command Line Tools (`xcode-select --install`). Works on Apple Silicon and Intel Macs with Metal-capable GPUs.

## Windows

1. **NVIDIA**: install the Game Ready or Studio driver + CUDA Toolkit from https://developer.nvidia.com/cuda-downloads. Ensure `nvcc --version` works in PowerShell.
2. **AMD/Intel**: Vulkan drivers are bundled with Adrenalin/Arc drivers. Install the Vulkan SDK from https://vulkan.lunarg.com/sdk/home (provides `glslc`).
3. Install Node.js 22+ and Git.
4. Run the automated script from a PowerShell prompt:
   ```powershell
   .\scripts\setup-llm.ps1 -Profile small
   ```
   Or build manually:
   ```powershell
   node node_modules\node-llama-cpp\dist\cli\cli.js source build --gpu cuda   # or vulkan
   ```
5. Visual Studio Build Tools (C++ workload) are required for compiling; install from https://visualstudio.microsoft.com/visual-cpp-build-tools/ if the build complains about a missing compiler.

## Verification

```bash
# Via MCP tool
autodoc_llm_status
# → activeModel.device should be cuda / vulkan / metal / rocm / sycl (not cpu)

# Via CLI
node node_modules/node-llama-cpp/dist/cli/cli.js inspect gpu
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `device: cpu` in status despite GPU present | GPU addon not built, or build failed during install | Re-run the setup script or the `source build --gpu ...` command and check the error |
| `spirv/unified1/spirv.hpp: No such file` (Vulkan build) | Distro SPIRV-Headers lacks CMake config | Vendor headers (see Vulkan section) and set `CMAKE_PREFIX_PATH` |
| `unsupported GNU version! gcc versions later than X` (CUDA build) | nvcc rejects the system GCC | `AUTODOC_CUDA_ALLOW_UNSUPPORTED_COMPILER=1`, or install a supported GCC and set `CUDA_HOST_COMPILER` |
| `Vulkan used VRAM` shows only iGPU | Discrete GPU not exposed via Vulkan driver | Update GPU drivers; on NVIDIA ensure the proprietary driver (not nouveau) is loaded |
| Build succeeds but `gpu: false` at runtime | Old build info cached | `node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu <backend>` re-selects it |
| `ninja: error: loading 'build.ninja'` | Stale build directory from a failed configure | Delete `node_modules/node-llama-cpp/llama/localBuilds/` and rebuild |

## What AutoDoc does automatically at runtime

- Detects and reports GPU stacks in `autodoc_llm_status`.
- Prepends `$CUDA_PATH/bin` to `PATH` for CUDA builds.
- Translates `AUTODOC_CUDA_ALLOW_UNSUPPORTED_COMPILER=1` into the `--allow-unsupported-compiler` CMake flag (no root needed).
- Falls back CPU → Vulkan → higher-priority backends depending on which addon binary loads successfully.
- Keeps deterministic regex-only behavior if the model or GPU is unavailable (`llmEnriched: false`).