#!/usr/bin/env bash
# AutoDoc — Local LLM automated setup (Linux/macOS)
#
# Detects the host GPU and available toolchains, installs what it can
# (respecting the system package manager), downloads the model and builds
# the best available node-llama-cpp backend.
#
# Usage:
#   ./scripts/setup-llm.sh              # auto-detect everything
#   ./scripts/setup-llm.sh --profile small|mid|large
#   ./scripts/setup-llm.sh --backend vulkan|cuda|cpu
#   AUTODOC_LLM_SKIP_BUILD=1 ./scripts/setup-llm.sh   # detection report only
#
# Windows users: run scripts/setup-llm.ps1 instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${REPO_ROOT}/.autodoc/models"
PROFILE="small"
BACKEND="auto"
MODEL_REPO="Qwen/Qwen2.5-Coder-3B-Instruct-GGUF"
MODEL_FILE="qwen2.5-coder-3b-instruct-q4_k_m.gguf"

log()  { printf "\033[1;34m[autodoc]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[  ok  ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[ warn ]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ fail ]\033[0m %s\n" "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

case "$PROFILE" in
  small) MODEL_REPO="Qwen/Qwen2.5-Coder-3B-Instruct-GGUF";  MODEL_FILE="qwen2.5-coder-3b-instruct-q4_k_m.gguf"  ;;
  mid)   MODEL_REPO="ggml-org/gemma-3-4b-it-GGUF";          MODEL_FILE="gemma-3-4b-it-Q4_K_M.gguf"              ;;
  large) MODEL_REPO="Qwen/Qwen2.5-Coder-7B-Instruct-GGUF";  MODEL_FILE="qwen2.5-coder-7b-instruct-q4_k_m.gguf"  ;;
  *) err "Unknown profile: $PROFILE (expected small|mid|large)"; exit 1 ;;
esac

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      echo "unknown" ;;
  esac
}
OS=$(detect_os)

detect_gpu_vendor() {
  if command -v nvidia-smi >/dev/null 2>&1; then echo "nvidia";
  elif command -v rocm-smi >/dev/null 2>&1; then echo "amd";
  elif [[ "$OS" == "macos" ]]; then echo "apple";
  elif command -v vulkaninfo >/dev/null 2>&1 && vulkaninfo --summary 2>/dev/null | grep -qiE "NVIDIA|AMD|Intel"; then
    echo "generic-vulkan"
  else echo "none"; fi
}

GPU_VENDOR=$(detect_gpu_vendor)
log "Detected OS: $OS | GPU vendor: $GPU_VENDOR | profile: $PROFILE | backend: $BACKEND"

PKG=""; SUDO=""
if [[ "$OS" == "linux" ]]; then
  if command -v apt-get >/dev/null 2>&1; then PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
  elif command -v pacman >/dev/null 2>&1; then PKG="pacman"
  elif command -v zypper >/dev/null 2>&1; then PKG="zypper"
  fi
  [[ "$(id -u)" != "0" ]] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

pkg_install() {
  # Installs OS packages; requires sudo for system package managers.
  if [[ -z "$PKG" ]]; then
    warn "No supported system package manager found; install '$1' manually."
    return 1
  fi
  log "Installing $1 (may request your password)..."
  case "$PKG" in
    apt)   $SUDO apt-get update -qq && $SUDO apt-get install -y "$1" ;;
    dnf)   $SUDO dnf install -y "$1" ;;
    pacman) $SUDO pacman -S --noconfirm "$1" ;;
    zypper) $SUDO zypper install -y "$1" ;;
  esac
}

# ---------- 1. Base toolchain (node, git, cmake, compilers) ----------
command -v node >/dev/null 2>&1 || { err "Node.js >= 22 required. Install from https://nodejs.org"; exit 1; }
ok "Node.js $(node -v)"

command -v git >/dev/null 2>&1 || pkg_install git || true

if ! command -v cmake >/dev/null 2>&1; then
  # node-llama-cpp downloads its own CMake if missing; note and continue.
  warn "cmake not found — node-llama-cpp will download a private copy during build."
fi

# Compilers per OS
if [[ "$OS" == "linux" ]]; then
  command -v g++ >/dev/null 2>&1 || pkg_install g++ || true
  command -v make >/dev/null 2>&1 || pkg_install make || true
elif [[ "$OS" == "macos" ]]; then
  xcode-select -p >/dev/null 2>&1 || { log "Installing Xcode Command Line Tools..."; xcode-select --install; }
fi

# ---------- 2. GPU backend selection & toolchain installation ----------
BACKENDS_TO_TRY=()
if [[ "$BACKEND" == "auto" ]]; then
  case "$GPU_VENDOR" in
    nvidia)        BACKENDS_TO_TRY=(cuda vulkan cpu) ;;
    amd)           BACKENDS_TO_TRY=(rocm vulkan cpu) ;;
    apple)         BACKENDS_TO_TRY=(metal cpu) ;;
    generic-vulkan) BACKENDS_TO_TRY=(vulkan cpu) ;;
    *)             BACKENDS_TO_TRY=(vulkan cpu) ;;
  esac
else
  BACKENDS_TO_TRY=("$BACKEND")
fi

install_backend_toolchain() {
  local backend="$1"
  case "$backend" in
    cuda)
      if command -v nvcc >/dev/null 2>&1 || [[ -n "${CUDA_PATH:-}" && -x "${CUDA_PATH}/bin/nvcc" ]]; then
        ok "CUDA toolkit already present."
        return 0
      fi
      log "CUDA toolkit not found. Install instructions:"
      echo "  Linux: https://developer.nvidia.com/cuda-downloads (or: $PKG install cuda for some distros)"
      echo "  Windows: https://developer.nvidia.com/cuda-downloads"
      echo "  After installing, re-run this script."
      return 1
      ;;
    vulkan)
      if command -v glslc >/dev/null 2>&1 && command -v vulkaninfo >/dev/null 2>&1; then
        ok "Vulkan toolchain (glslc + vulkaninfo) present."
        return 0
      fi
      log "Installing Vulkan toolchain (glslc, vulkan headers/loader/drivers)..."
      if [[ "$OS" == "linux" ]]; then
        case "$PKG" in
          dnf)    pkg_install glslc && pkg_install vulkan-headers && pkg_install mesa-vulkan-drivers ;;
          apt)    pkg_install glslc && pkg_install vulkan-tools && pkg_install mesa-vulkan-drivers ;;
          pacman) pkg_install shaderc && pkg_install vulkan-headers && pkg_install vulkan-tools ;;
          zypper) pkg_install glslc && pkg_install vulkan-devel && pkg_install libvulkan1 ;;
          *) return 1 ;;
        esac
      elif [[ "$OS" == "macos" ]]; then
        warn "Vulkan on macOS is rarely needed (Metal is native). Install MoltenVK manually if required."
        return 1
      fi
      command -v glslc >/dev/null 2>&1
      ;;
    rocm)
      command -v rocm-smi >/dev/null 2>&1 || {
        log "ROCm install is distro-specific. See https://rocm.docs.amd.com/projects/install-on-linux"
        return 1
      }
      ;;
    metal)
      [[ "$OS" == "macos" ]] || return 1
      ok "Metal available natively on macOS."
      ;;
    cpu) return 0 ;;
  esac
}

# ---------- 3. Vendored SPIRV-Headers (Vulkan only, when distro package lacks CMake config) ----------
prepare_spirv_headers() {
  if [[ -n "${CMAKE_PREFIX_PATH:-}" ]] && [[ "$CMAKE_PREFIX_PATH" == *SPIRV-Headers* || "$CMAKE_PREFIX_PATH" == *spirv* ]]; then
    ok "SPIRV-Headers already referenced via CMAKE_PREFIX_PATH."
    return 0
  fi
  local spirv_dir="${REPO_ROOT}/.autodoc/spirv-headers"
  if [[ -d "$spirv_dir/prefix" ]]; then
    export CMAKE_PREFIX_PATH="$spirv_dir/prefix${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
    ok "Using vendored SPIRV-Headers at $spirv_dir/prefix"
    return 0
  fi
  log "Vendoring SPIRV-Headers (llama.cpp requires a CMake config module many distro packages omit)..."
  mkdir -p "$spirv_dir"
  git clone --depth 1 https://github.com/KhronosGroup/SPIRV-Headers.git "$spirv_dir/src" 2>/dev/null || true
  local cmake_bin="cmake"
  [[ -x "${REPO_ROOT}/node_modules/node-llama-cpp/llama/xpack/xpacks/@xpack-dev-tools/cmake/.content/bin/cmake" ]] && \
    cmake_bin="${REPO_ROOT}/node_modules/node-llama-cpp/llama/xpack/xpacks/@xpack-dev-tools/cmake/.content/bin/cmake"
  "$cmake_bin" -S "$spirv_dir/src" -B "$spirv_dir/build" -DCMAKE_INSTALL_PREFIX="$spirv_dir/prefix" >/dev/null 2>&1
  "$cmake_bin" --install "$spirv_dir/build" >/dev/null 2>&1
  export CMAKE_PREFIX_PATH="$spirv_dir/prefix${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
  ok "SPIRV-Headers vendored at $spirv_dir/prefix"
}

# ---------- 4. Model download ----------
mkdir -p "$MODELS_DIR"
if [[ -f "$MODELS_DIR/$MODEL_FILE" ]]; then
  ok "Model already downloaded: $MODEL_FILE"
else
  log "Downloading model ($PROFILE profile)..."
  if command -v hf >/dev/null 2>&1; then
    hf download "$MODEL_REPO" "$MODEL_FILE" --local-dir "$MODELS_DIR"
  elif command -v huggingface-cli >/dev/null 2>&1; then
    huggingface-cli download "$MODEL_REPO" "$MODEL_FILE" --local-dir "$MODELS_DIR"
  else
    log "No HuggingFace CLI found. Trying curl fallback..."
    local_url="https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}"
    if command -v curl >/dev/null 2>&1; then
      curl -L --fail -o "$MODELS_DIR/$MODEL_FILE" "$local_url"
    else
      err "Cannot download model: install huggingface-cli (pip install -U huggingface_hub) or curl."
      exit 1
    fi
  fi
  ok "Model ready: $MODELS_DIR/$MODEL_FILE"
fi

# ---------- 5. node-llama-cpp install & backend build ----------
if [[ "${AUTODOC_LLM_SKIP_BUILD:-0}" == "1" ]]; then
  log "AUTODOC_LLM_SKIP_BUILD=1 — skipping backend build."
else
  npm install node-llama-cpp --workspace @autodoc/mcp 2>&1 | tail -1

  BUILT=""
  for backend in "${BACKENDS_TO_TRY[@]}"; do
    log "Preparing backend: $backend"
    install_backend_toolchain "$backend" || { warn "Backend '$backend' toolchain unavailable; trying next."; continue; }
    [[ "$backend" == "vulkan" ]] && prepare_spirv_headers || true
    [[ "$backend" == "cuda" && -n "${CUDA_PATH:-}" ]] && export PATH="${CUDA_PATH}/bin:$PATH"

    if [[ "$backend" == "cpu" ]]; then
      ok "CPU backend requires no extra build (prebuilt binary used)."
      BUILT="cpu"; break
    fi

    # GCC > 15 vs nvcc workaround
    GCC_MAJOR=$( (g++ --version 2>/dev/null | head -1) | grep -oE '[0-9]+' | head -1 || echo 0)
    if [[ "$backend" == "cuda" && "$GCC_MAJOR" -gt 15 ]]; then
      export AUTODOC_CUDA_ALLOW_UNSUPPORTED_COMPILER=1
      export NODE_LLAMA_CPP_CMAKE_OPTION_CMAKE_CUDA_FLAGS="--allow-unsupported-compiler"
      warn "GCC ${GCC_MAJOR} detected (> 15): enabling --allow-unsupported-compiler for nvcc."
    fi

    log "Building node-llama-cpp with $backend backend (this compiles llama.cpp; may take several minutes)..."
    if node node_modules/node-llama-cpp/dist/cli/cli.js source build --gpu "$backend" --noUsageExample 2>&1 | tail -2; then
      ok "Backend '$backend' built successfully."
      BUILT="$backend"
      break
    else
      warn "Backend '$backend' build failed; trying next."
    fi
  done

  [[ -z "$BUILT" ]] && { err "No GPU backend could be built; node-llama-cpp will use its CPU prebuilt binary."; BUILT="cpu"; }
fi

# ---------- 6. Persist env hints ----------
ENV_FILE="${REPO_ROOT}/.autodoc/llm.env"
{
  echo "# Generated by scripts/setup-llm.sh on $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo "export AUTODOC_LLM_PROFILE=$PROFILE"
  [[ -n "${CMAKE_PREFIX_PATH:-}" ]] && echo "export CMAKE_PREFIX_PATH=$CMAKE_PREFIX_PATH"
  [[ "$BACKEND" == "cuda" && "$GCC_MAJOR" -gt 15 ]] && echo "export AUTODOC_CUDA_ALLOW_UNSUPPORTED_COMPILER=1"
  [[ -n "${CUDA_PATH:-}" ]] && echo "export CUDA_PATH=$CUDA_PATH"
} > "$ENV_FILE"
ok "Environment hints written to $ENV_FILE (source it before starting the MCP server)."

# ---------- 7. Final report ----------
log "Setup complete. Summary:"
echo "  model:  $PROFILE ($MODEL_FILE)"
echo "  backend:${BUILT:-auto}"
echo "  next:   restart your MCP server so tools pick up the new backend."
[[ "${AUTODOC_LLM_SKIP_BUILD:-0}" != "1" ]] && true
exit 0