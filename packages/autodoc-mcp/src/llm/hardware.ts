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
  device: "cpu" | "cuda" | "vulkan" | "metal";
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

  const nvidia = await probeVram("nvidia-smi", [
    "--query-gpu=memory.total,memory.free",
    "--format=csv,noheader,nounits",
  ]);
  if (nvidia) {
    [totalVramBytes, freeVramBytes] = nvidia;
    detectedVia.push("nvidia-smi");
    device = "cuda";
  } else {
    const rocm = await probeVram("rocm-smi", ["--showmeminfo", "vram", "--csv"]);
    if (rocm) {
      [totalVramBytes, freeVramBytes] = rocm;
      detectedVia.push("rocm-smi");
      device = "vulkan";
    } else {
      const metal = await probeVram("powermetrics", ["--samplers", "smc", "-n", "1"]);
      if (metal !== undefined) {
        detectedVia.push("powermetrics");
        device = "metal";
      }
    }
  }

  const budgets = [freeRamBytes];
  if (freeVramBytes !== undefined) budgets.push(freeVramBytes);
  const effectiveBudgetBytes = Math.min(...budgets);

  return { totalRamBytes, freeRamBytes, totalVramBytes, freeVramBytes, effectiveBudgetBytes, device, detectedVia };
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
  const megabytes = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /,/.test(l))
    .flatMap((l) => l.split(",").map((v) => parseInt(v.trim(), 10)))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (cmd === "nvidia-smi" && megabytes.length >= 2) {
    return [megabytes[0] * 1024 ** 2, megabytes[1] * 1024 ** 2];
  }
  return undefined;
}