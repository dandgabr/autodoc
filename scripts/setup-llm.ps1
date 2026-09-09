# AutoDoc — Local LLM automated setup (Windows PowerShell)
#
# Detects the GPU (NVIDIA CUDA preferred, then Vulkan), installs the model,
# and builds the best available node-llama-cpp backend.
#
# Usage:
#   .\scripts\setup-llm.ps1
#   .\scripts\setup-llm.ps1 -Profile large
#   .\scripts\setup-llm.ps1 -Backend cuda

param(
  [Parameter(Mandatory = $false)]
  [ValidateSet("small", "mid", "large")]
  [string]$Profile = "small",

  [Parameter(Mandatory = $false)]
  [ValidateSet("auto", "cuda", "vulkan", "cpu")]
  [string]$Backend = "auto"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$ModelsDir = Join-Path $RepoRoot ".autodoc\models"

$ModelMap = @{
  small = @{ repo = "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF"; file = "qwen2.5-coder-3b-instruct-q4_k_m.gguf" }
  mid   = @{ repo = "ggml-org/gemma-3-4b-it-GGUF";          file = "gemma-3-4b-it-Q4_K_M.gguf" }
  large = @{ repo = "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF";  file = "qwen2.5-coder-7b-instruct-q4_k_m.gguf" }
}
$Spec = $ModelMap[$Profile]

function Write-Step($msg)  { Write-Host "[autodoc] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[  ok  ] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[ warn ] $msg" -ForegroundColor Yellow }

# ---------- 1. Base toolchain ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "Node.js >= 22 required. Install from https://nodejs.org"; exit 1 }
Write-Ok "Node.js $((node -v))"

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Write-Warn2 "git not found; needed for SPIRV-Headers vendoring (Vulkan path only)." }

# ---------- 2. GPU detection ----------
$GpuVendor = "none"
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidiaSmi) { $GpuVendor = "nvidia" }
elseif (Get-Command rocm-smi -ErrorAction SilentlyContinue) { $GpuVendor = "amd" }
elseif (Get-Command vulkaninfo -ErrorAction SilentlyContinue) { $GpuVendor = "vulkan-capable" }
Write-Step "GPU vendor: $GpuVendor | profile: $Profile | backend: $Backend"

$BackendsToTry = @()
switch ($Backend) {
  "auto" {
    switch ($GpuVendor) {
      "nvidia"          { $BackendsToTry = @("cuda", "vulkan", "cpu") }
      "amd"             { $BackendsToTry = @("vulkan", "cpu") }
      "vulkan-capable"  { $BackendsToTry = @("vulkan", "cpu") }
      default           { $BackendsToTry = @("vulkan", "cpu") }
    }
  }
  default { $BackendsToTry = @($Backend) }
}

# ---------- 3. Model download ----------
if (-not (Test-Path $ModelsDir)) { New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null }
$ModelTarget = Join-Path $ModelsDir $Spec.file
if (Test-Path $ModelTarget) {
  Write-Ok "Model already downloaded: $($Spec.file)"
} else {
  Write-Step "Downloading model ($Profile)..."
  $url = "https://huggingface.co/$($Spec.repo)/resolve/main/$($Spec.file)"
  try {
    Invoke-WebRequest -Uri $url -OutFile $ModelTarget -UseBasicParsing
    Write-Ok "Model ready: $ModelTarget"
  } catch {
    Write-Error "Model download failed: $_. Install huggingface-cli (pip install -U huggingface_hub) and retry."
    exit 1
  }
}

# Integrity check: verify SHA-256 against HuggingFace LFS metadata (x-linked-etag).
$HeadResponse = Invoke-WebRequest -Uri "https://huggingface.co/$($Spec.repo)/raw/main/$($Spec.file)" -Method Head -UseBasicParsing
$ExpectedSha = ($HeadResponse.Headers["x-linked-etag"] | Select-Object -First 1) -replace '"', ""
if ($ExpectedSha -match '^[a-f0-9]{64}$') {
  $LocalSha = (Get-FileHash -Path $ModelTarget -Algorithm SHA256).Hash.ToLower()
  if ($LocalSha -eq $ExpectedSha.ToLower()) {
    Write-Ok "Model SHA-256 verified: $($LocalSha.Substring(0, 16))..."
  } else {
    Write-Error "SHA-256 MISMATCH for $($Spec.file) (expected $($ExpectedSha.Substring(0,16))..., got $($LocalSha.Substring(0,16))...). Delete the file and re-run."
    exit 1
  }
} else {
  Write-Warn2 "Could not fetch upstream SHA-256 — verify manually before production use."
}

# ---------- 4. node-llama-cpp install & build ----------
Write-Step "Installing node-llama-cpp..."
npm install node-llama-cpp --workspace "@autodoc/mcp" 2>$null | Out-Null

$Built = ""
foreach ($backend in $BackendsToTry) {
  Write-Step "Preparing backend: $backend"
  if ($backend -eq "cuda") {
    $nvcc = Get-Command nvcc -ErrorAction SilentlyContinue
    if (-not $nvcc) {
      Write-Warn2 "CUDA toolkit (nvcc) not found. Install from https://developer.nvidia.com/cuda-downloads then re-run."
      continue
    }
    # nvcc rejects newer GCC/MSVC toolchains; enable the skip flag defensively.
    $env:NODE_LLAMA_CPP_CMAKE_OPTION_CMAKE_CUDA_FLAGS = "--allow-unsupported-compiler"
    if (-not $env:CUDA_PATH) {
      # nvcc typically lives at <CUDA>\bin\nvcc.exe
      $env:CUDA_PATH = Split-Path (Split-Path $nvcc.Source)
    }
    $env:PATH = "$(Join-Path $env:CUDA_PATH 'bin');" + $env:PATH
  }

  if ($backend -eq "cpu") { $Built = "cpu"; break }

  Write-Step "Building node-llama-cpp with $backend backend (may take several minutes)..."
  try {
    node (Join-Path $RepoRoot "node_modules\node-llama-cpp\dist\cli\cli.js") source build --gpu $backend --noUsageExample
    if ($LASTEXITCODE -eq 0) { $Built = $backend; Write-Ok "Backend '$backend' built."; break }
  } catch {
    Write-Warn2 "Backend '$backend' build failed: $_"
  }
}
if (-not $Built) { $Built = "cpu"; Write-Warn2 "Falling back to CPU prebuilt binary." }

# ---------- 5. Persist env hints ----------
$EnvFile = Join-Path $RepoRoot ".autodoc\llm.env.ps1"
@"
# Generated by scripts/setup-llm.ps1
`$env:AUTODOC_LLM_PROFILE = "$Profile"
if ($env:CUDA_PATH) { `$env:CUDA_PATH = "$env:CUDA_PATH" }
"@ | Set-Content -Path $EnvFile
Write-Ok "Environment hints written to $EnvFile (dot-source it before starting the MCP server)."

Write-Step "Setup complete: model=$Profile backend=$Built. Restart your MCP server."