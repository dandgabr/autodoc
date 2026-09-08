import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

describe("Protocol & Client Compatibility", () => {
  const cliPath = path.resolve(__dirname, "../dist/index.js");

  it("should generate valid OpenCode configuration with --print-opencode-config flag", () => {
    const output = execSync(`node ${cliPath} --print-opencode-config`, {
      encoding: "utf8"
    });

    const parsed = JSON.parse(output);
    expect(parsed).toBeDefined();
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.autodoc).toBeDefined();

    const autodoc = parsed.mcpServers.autodoc;
    expect(autodoc.command).toBe("node");
    expect(autodoc.args.length).toBeGreaterThan(0);
    expect(autodoc.env.AUTODOC_LOCALE).toBe("en-US");
    expect(autodoc.env.NODE_ENV).toBe("production");
  });

  it("should output valid JSON for OpenCode config copy-paste", () => {
    const output = execSync(`node ${cliPath} --print-opencode-config`, {
      encoding: "utf8"
    });

    expect(() => JSON.parse(output)).not.toThrow();
    const config = JSON.parse(output);
    expect(config.mcpServers.autodoc.args[0]).toContain("dist/index.js");
  });
});
