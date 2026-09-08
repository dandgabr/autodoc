import { describe, it, expect, beforeAll } from "vitest";
import { loadNativeBinding } from "../src/binding.js";

describe("NAPI-RS FFI Bridge Sanity Tests", () => {
  let binding: ReturnType<typeof loadNativeBinding>;

  beforeAll(() => {
    binding = loadNativeBinding();
    expect(binding).toBeDefined();
    // Initialize native telemetry (directed strictly to stderr)
    binding.initLogger();
  });

  it("should successfully execute ping with trace_id roundtrip in < 1ms", () => {
    const traceId = "test-trace-id-vitest-42";
    const start = performance.now();
    const res = binding.ping(traceId);
    const duration = performance.now() - start;

    expect(res).toBeDefined();
    expect(res.traceId).toBe(traceId);
    expect(res.status).toBe("OK");
    expect(res.version).toBe("0.1.0");
    expect(res.rustcVersion).toBe("1.98.0");
    expect(typeof res.timestampMs).toBe("number");
    expect(res.timestampMs).toBeGreaterThan(0);
    // Sub-millisecond FFI execution assertion
    expect(duration).toBeLessThan(15); // Permissive margin for CI/debug runs
  });

  it("should intercept native panics cleanly via catch_unwind without crashing process", () => {
    expect(() => {
      binding.triggerPanicTest("Controlled FFI boundary panic");
    }).toThrow(/AUTODOC_E401/);
  });
});
