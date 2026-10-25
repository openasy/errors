import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "errors-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // errors's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let project = "";
  let key = "";
  let issue = "";
  const event = {
    release: "1.0.0",
    user: { id: "u1" },
    exception: { type: "TypeError", value: "x is undefined", frames: [{ filename: "src/cart.js", function: "total", lineno: 12, in_app: true }] },
  };
  const withKey = (k: string, body: unknown) => ({
    headers: { "x-errors-key": k, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("projects: add, change, new key", async () => {
    const created = (await call("POST", "/api/v1/projects", admin({ name: "shop", rateLimit: 5 }))).body as { id: string; key: string };
    project = created.id;
    key = created.key;
    await call("POST", "/api/v1/projects", admin({ name: "shop" }));
    await call("POST", "/api/v1/projects", admin({ name: "bad name" }));
    await call("POST", "/api/v1/projects", admin("nope"));
    await call("POST", "/api/v1/projects", {});
    await call("GET", "/api/v1/projects", admin());
    await call("GET", "/api/v1/projects", admin(), "/api/v1/projects?limit=1");
    await call("GET", "/api/v1/projects", admin(), "/api/v1/projects?limit=0");
    await call("GET", "/api/v1/projects", {});
    await call("GET", "/api/v1/projects/{id}", admin(), `/api/v1/projects/${project}`);
    await call("GET", "/api/v1/projects/{id}", admin(), "/api/v1/projects/missing");
    await call("PATCH", "/api/v1/projects/{id}", admin({ rateLimit: 3 }), `/api/v1/projects/${project}`);
    await call("PATCH", "/api/v1/projects/{id}", admin({ rateLimit: 0 }), `/api/v1/projects/${project}`);
    await call("PATCH", "/api/v1/projects/{id}", admin("nope"), `/api/v1/projects/${project}`);
    await call("PATCH", "/api/v1/projects/{id}", admin({ rateLimit: 3 }), "/api/v1/projects/missing");
    await call("PATCH", "/api/v1/projects/{id}", { method: "PATCH" }, `/api/v1/projects/${project}`);
    const other = (await call("POST", "/api/v1/projects", admin({ name: "spare" }))).body as { id: string };
    await call("POST", "/api/v1/projects/{id}/key", admin(), `/api/v1/projects/${other.id}/key`);
    await call("POST", "/api/v1/projects/{id}/key", admin(), "/api/v1/projects/missing/key");
    await call("POST", "/api/v1/projects/{id}/key", { method: "POST" }, `/api/v1/projects/${other.id}/key`);
    await call("DELETE", "/api/v1/projects/{id}", admin(), `/api/v1/projects/${other.id}`);
    await call("DELETE", "/api/v1/projects/{id}", admin(), `/api/v1/projects/${other.id}`);
    await call("DELETE", "/api/v1/projects/{id}", { method: "DELETE" }, "/api/v1/projects/x");
  });

  it("events: stored, refused and limited", async () => {
    issue = ((await call("POST", "/api/v1/events", withKey(key, event))).body as { issue: { id: string } }).issue.id;
    await call("POST", "/api/v1/events", withKey(key, { ...event, release: "1.1.0" }));
    await call("POST", "/api/v1/events", withKey(key, "{nope"));
    await call("POST", "/api/v1/events", withKey(key, { hello: 1 }));
    await call("POST", "/api/v1/events", withKey("ek_wrong", event));
    await call("POST", "/api/v1/events", { method: "POST" });
    await call("POST", "/api/v1/events", withKey(key, "x".repeat(1_100_000)));
    const limited = await call("POST", "/api/v1/events", withKey(key, event));
    expect(limited.res.status).toBe(429);
    expect(Number(limited.res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("issues and releases", async () => {
    const { body } = await call("GET", "/api/v1/issues", admin());
    expect((body as { issues: unknown[] }).issues).toHaveLength(1);
    await call(
      "GET",
      "/api/v1/issues",
      admin(),
      `/api/v1/issues?project=${project}&status=unresolved&environment=production&release=1.0.0&q=cart&sort=events&limit=1`,
    );
    await call("GET", "/api/v1/issues", admin(), "/api/v1/issues?status=gone");
    await call("GET", "/api/v1/issues", admin(), "/api/v1/issues?sort=loudest");
    await call("GET", "/api/v1/issues", admin(), "/api/v1/issues?project=missing");
    await call("GET", "/api/v1/issues", {});
    await call("GET", "/api/v1/issues/{id}", admin(), `/api/v1/issues/${issue}`);
    await call("GET", "/api/v1/issues/{id}", admin(), "/api/v1/issues/missing");
    await call("GET", "/api/v1/issues/{id}", {}, `/api/v1/issues/${issue}`);
    await call("PATCH", "/api/v1/issues/{id}", admin({ status: "resolved", release: "1.2.0" }), `/api/v1/issues/${issue}`);
    await call("PATCH", "/api/v1/issues/{id}", admin({ status: "ignored" }), `/api/v1/issues/${issue}`);
    await call("PATCH", "/api/v1/issues/{id}", admin({ status: "fixed" }), `/api/v1/issues/${issue}`);
    await call("PATCH", "/api/v1/issues/{id}", admin("nope"), `/api/v1/issues/${issue}`);
    await call("PATCH", "/api/v1/issues/{id}", admin({ status: "resolved" }), "/api/v1/issues/missing");
    await call("PATCH", "/api/v1/issues/{id}", { method: "PATCH" }, `/api/v1/issues/${issue}`);
    await call("GET", "/api/v1/releases", admin());
    await call("GET", "/api/v1/releases", admin(), `/api/v1/releases?project=${project}&limit=1`);
    await call("GET", "/api/v1/releases", admin(), "/api/v1/releases?project=missing");
    await call("GET", "/api/v1/releases", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/overview", admin());
    await call("GET", "/api/v1/summary", {});
    await call("DELETE", "/api/v1/issues/{id}", admin(), `/api/v1/issues/${issue}`);
    await call("DELETE", "/api/v1/issues/{id}", admin(), `/api/v1/issues/${issue}`);
    await call("DELETE", "/api/v1/issues/{id}", { method: "DELETE" }, "/api/v1/issues/x");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
