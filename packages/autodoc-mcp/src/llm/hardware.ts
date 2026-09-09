/**
 * Host hardware capability detection for local LLM model selection.
 *
 * Detects free RAM always, and free VRAM when a GPU management CLI is
 * present. Classification is conservative: the chosen profile must fit
 * within the smaller of the two budgets with a safety margin.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { MODEL_CATALOG, PROFILE_ORDER, SELECTION_SAFETY_MARGIN, type ModelProfile, type ModelSpec } from "./models.js";

const execFileAsync = promisify(execFile);

export interface HostCapabilities {
  totalRamBytes: number;
  freeRamBytes: number;
  totalVramBytes?: number;
  freeVramBytes?: number;
  /** Best available budget in bytes (min of VRAM-free and RAM-free when both known). */
  effectiveBudgetBytes: number;
  device: "cpu" | "cuda" | "vulkan" | "metal" | "rocm" | "sycl" | "cpu-fallback";
  detectedVia: string[];
}

export function classifyProfile(caps: HostCapabilities): ModelProfile | null {
  const margin = 1 - SELECTION_SAFETY_MARGIN;
  for (const profile of [...PROFILE_ORDER].reverse()) {
    const spec: ModelSpec = MODEL_CATALOG[profile];
    const needed = spec.totalBudgetGb * 1024 ** 3;
    if (caps.effectiveBudgetBytes >= needed * margin) {
      return profile;
    }
  }
  return null;
}

export async function detectHostCapabilities(): Promise<HostCapabilities> {
  const totalRamBytes = os.totalmem();
  const freeRamBytes = os.freemem();
  const detectedVia: string[] = ["os.freemem"];

  let totalVramBytes: number | undefined;
  let freeVramBytes: number | undefined;
  let device: HostCapabilities["device"] = "cpu";
  /** GPU backend preference order for inference: highest-performance available. */
  const gpuBackends: Array<{ priority: number; device: HostCapabilities["device"] }> = [];

  // Probe ALL GPU sources independently — a host may expose several stacks
  // (e.g. NVIDIA CUDA + Vulkan, Intel iGPU via OpenCL/Level Zero). The
  // factory picks the highest-priority backend the runtime can actually use.

  // Probe ALL GPU sources in parallel — they are independent CLI calls with
  // per-probe timeouts; sequential awaiting would cost ~17s on GPU-less hosts.
  const [nvidia, rocm, syclGpu, vulkanGpus, metal] = await Promise.all([
    probeVram("nvidia-smi", ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"]),
    probeVram("rocm-smi", ["--showmeminfo", "vram", "--csv"]),
    probeSyclGpu(),
    probeVulkanGpus(),
    probeVram("powermetrics", ["--samplers", "smc", "-n", "1"]),
  ]);

  if (nvidia) {
    [totalVramBytes, freeVramBytes] = nvidia;
    detectedVia.push("nvidia-smi");
    gpuBackends.push({ priority: 1, device: "cuda" });
  }

  if (rocm) {
    if (freeVramBytes === undefined || rocm[1] < freeVramBytes) {
      // Keep the tightest VRAM budget across GPUs for model sizing.
      [totalVramBytes, freeVramBytes] = rocm;
    }
    detectedVia.push("rocm-smi");
    gpuBackends.push({ priority: 2, device: "rocm" });
  }

  if (syclGpu) {
    detectedVia.push("sycl-ls");
    gpuBackends.push({ priority: 3, device: "sycl" });
    if (freeVramBytes === undefined) {
      // SYCL probe cannot report VRAM reliably; treat iGPU as RAM-constrained.
      freeVramBytes = freeRamBytes;
      totalVramBytes = totalRamBytes;
    }
  }

  if (vulkanGpus.length > 0) {
    detectedVia.push(`vulkaninfo(${vulkanGpus.slice(0, 2).join(", ")})`);
    gpuBackends.push({ priority: 4, device: "vulkan" });
    if (freeVramBytes === undefined) {
      freeVramBytes = freeRamBytes;
      totalVramBytes = totalRamBytes;
    }
  }

  if (metal !== undefined) {
    detectedVia.push("powermetrics");
    gpuBackends.push({ priority: 3, device: "metal" });
    if (freeVramBytes === undefined) {
      freeVramBytes = freeRamBytes;
      totalVramBytes = totalRamBytes;
    }
  }

  gpuBackends.sort((a, b) => a.priority - b.priority);
  device = gpuBackends[0]?.device ?? "cpu";
  if (device === "cpu") {
    detectedVia.push("no-gpu-detected");
  }

  const budgets = [freeRamBytes];
  if (freeVramBytes !== undefined) budgets.push(freeVramBytes);
  const effectiveBudgetBytes = Math.min(...budgets);

  return { totalRamBytes, freeRamBytes, totalVramBytes, freeVramBytes, effectiveBudgetBytes, device, detectedVia };
}

/** Detects GPU devices exposed by Intel oneAPI SYCL runtimes (requires oneAPI env sourced). */
async function probeSyclGpu(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("sycl-ls", [], { timeout: 3000 });
    // GPU devices appear as "[sycl:gpu]" or vendor-prefixed GPU entries.
    return /gpu/i.test(stdout) && !/no device/i.test(stdout);
  } catch {
    return false;
  }
}

/** Parses vulkaninfo --summary device names for real GPUs (excludes software renderers). */
async function probeVulkanGpus(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("vulkaninfo", ["--summary"], { timeout: 5000 });
    const names: string[] = [];
    const sections = stdout.split(/GPU\d+:/);
    for (const section of sections.slice(1)) {
      const name = /deviceName\s*=\s*(.+)/.exec(section)?.[1]?.trim();
      if (name && !/llvmpipe|swiftshader|software/i.test(name)) {
        names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

async function probeVram(cmd: string, args: string[]): Promise<[number, number] | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 3000 });
    return parseVramOutput(cmd, stdout);
  } catch {
    return undefined;
  }
}

function parseVramOutput(cmd: string, stdout: string): [number, number] | undefined {
  // Numbers on a comma-separated line (nvidia-smi CSV format).
  const megabytes = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /,/.test(l))
    .flatMap((l) => l.split(",").map((v) => parseInt(v.trim(), 10)))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (megabytes.length >= 2) {
    return [megabytes[0] * 1024 ** 2, megabytes[1] * 1024 ** 2];
  }
  // rocm-smi --csv format: "gpu,used_vram,total_vram" lines in KiB.
  const rocmMatch = /vram.*?(\d+).*?(\d+)/i.exec(stdout.replace(/\s/g, " "));
  if (cmd === "rocm-smi" && rocmMatch) {
    return [parseInt(rocmMatch[2], 10) * 1024, parseInt(rocmMatch[1], 10) * 1024];
  }
  return undefined;
}