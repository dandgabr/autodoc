import { describe, it, expect } from "vitest";
import { extractPathParams, extractRequestBody, extractResponses, extractHandlerParams } from "../src/analyzers/rest/operations.js";
import { OpenApiGenerator } from "../src/analyzers/rest/openapi.js";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";

describe("REST operation contract extraction", () => {
  it("extracts path params from Express-style routes", () => {
    const params = extractPathParams("/api/users/:userId/posts/:postId");
    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({ name: "userId", in: "path", required: true });
  });

  it("extracts path params from FastAPI brace routes", () => {
    const params = extractPathParams("/api/v1/items/{itemId}");
    expect(params.map((p) => p.name)).toEqual(["itemId"]);
  });

  it("infers request body from Zod schemas", () => {
    const body = extractRequestBody(
      "const S = z.object({ name: z.string(), email: z.string().email(), age: z.number().int().optional() })",
      "POST",
      "node"
    );
    expect(body?.properties.map((p) => p.name)).toEqual(["name", "email", "age"]);
    expect(body?.required).toEqual(["name", "email"]);
  });

  it("returns no body for GET", () => {
    expect(extractRequestBody("anything", "GET", "node")).toBeUndefined();
  });

  it("extracts responses from status+json literals", () => {
    const res = extractResponses(
      "if (!x) return res.status(400).json({ error: 'bad' });\nres.status(201).json({ id: '1' });",
      "node"
    );
    const codes = res.map((r) => r.statusCode);
    expect(codes).toContain("201");
    expect(codes).toContain("400");
  });

  it("extracts query params from Express handlers", () => {
    const params = extractHandlerParams("const page = req.query.page; const q = req.query.search;", "node");
    expect(params.map((p) => p.name)).toEqual(["page", "search"]);
  });
});

describe("OpenApiGenerator", () => {
  function makeFixtureRepo(): string {
    const dir = mkdtempSync(join(os.tmpdir(), "autodoc-oas-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "app.js"),
      "import usersRouter from './users.routes.js'\napp.use('/api/v1', usersRouter)\n"
    );
    writeFileSync(
      join(dir, "src", "users.routes.js"),
      [
        "import { z } from 'zod'",
        "const S = z.object({ name: z.string(), email: z.string().email() })",
        "router.post('/users', (req, res) => { res.status(201).json({ id: '1' }) })",
        "router.get('/users/:id', (req, res) => { res.json({ id: '1', name: 'x' }) })",
      ].join("\n")
    );
    return dir;
  }

  it("compiles a valid OAS 3.1 document with parameters and responses", () => {
    const g = new OpenApiGenerator(makeFixtureRepo(), { title: "T" });
    const r = g.compile();
    expect(r.document.openapi).toBe("3.1.0");
    const paths = Object.keys(r.document.paths);
    expect(paths.some((p) => p.includes("users"))).toBe(true);
    const post = r.document.paths["/api/v1/users"]?.post;
    expect(post).toBeDefined();
    expect(post.responses["201"]).toBeDefined();
  });

  it("exports openapi.json to a directory", () => {
    const outDir = mkdtempSync(join(os.tmpdir(), "autodoc-oas-out-"));
    const g = new OpenApiGenerator(makeFixtureRepo(), { title: "T" });
    const r = g.exportToDirectory(outDir);
    expect(r.writtenTo).toContain("openapi.json");
  });
});