import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import { parseLimit, ErrorsError, type Errors, type IssueFilter, type ProblemCode, type Status } from "./errors.ts";

export interface AppOptions {
  db: DatabaseSync;
  errors: Errors;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(errors: Errors, version: string) {
  return renderMetrics(version, { projects: errors.projectCount(), issues: errors.issueTotals(), regressions: errors.summary().regressions });
}

/** Serves only /metrics, for a port that is not exposed with the rest (ERRORS_METRICS_PORT). */
export function createMetricsHandler(errors: Errors, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(errors, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
};

/** Largest event accepted, after decompression. A stack trace of 100 frames is a few tens of KiB. */
const EVENT_LIMIT = 1024 * 1024;

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "invalid-event": "Invalid event",
  "not-found": "Not found",
  conflict: "Conflict",
  "rate-limited": "Too many events",
  "not-configured": "Not configured",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** Reads the whole body, gunzipping it when sent with `Content-Encoding: gzip`, up to limit bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding !== "gzip" && encoding !== "identity") throw new ErrorsError(400, "invalid-body", "Content-Encoding must be gzip or absent.");
  const source = encoding === "gzip" ? req.pipe(createGunzip()) : req;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new ErrorsError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024 / 1024)} MiB.`);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof ErrorsError) throw err;
    throw new ErrorsError(400, "invalid-body", "The gzip body could not be read.");
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limit).catch((err: unknown) => {
    if (err instanceof ErrorsError && err.code === "payload-too-large")
      throw new ErrorsError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
    throw err;
  });
  try {
    const body = JSON.parse(raw.toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new ErrorsError(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003), or "project" for events sent with a project key. */
type Access = "none" | "project" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  /** The project a key belongs to, for routes that take one. */
  project: { id: string; rateLimit: number } | null;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

function issueFilter(url: URL, projectId?: string): IssueFilter {
  const status = url.searchParams.get("status");
  if (status !== null && status !== "unresolved" && status !== "resolved" && status !== "ignored")
    throw new ErrorsError(422, "invalid-body", "status must be unresolved, resolved or ignored.");
  const sort = url.searchParams.get("sort") ?? "lastSeen";
  if (sort !== "lastSeen" && sort !== "firstSeen" && sort !== "events" && sort !== "users")
    throw new ErrorsError(422, "invalid-body", "sort must be lastSeen, firstSeen, events or users.");
  const q = url.searchParams.get("q")?.trim();
  if (q && q.length > 128) throw new ErrorsError(422, "invalid-body", "q must be at most 128 characters.");
  const one = (name: string) => {
    const v = url.searchParams.get(name);
    if (v !== null && (v.length < 1 || v.length > 200)) throw new ErrorsError(422, "invalid-body", `${name} must be 1 to 200 characters.`);
    return v ?? undefined;
  };
  return {
    projectId: projectId ?? one("project"),
    status: (status as Status | null) ?? undefined,
    environment: one("environment"),
    release: one("release"),
    q: q || undefined,
    sort,
  };
}

export function createApp({ db, errors, version, auth, adminToken, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const cursor = (url: URL) => url.searchParams.get("cursor") ?? undefined;
  const limit = (url: URL) => parseLimit(url.searchParams.get("limit"));
  const page = <K extends string, T>(key: K, p: { items: T[]; nextCursor?: string }) =>
    ({ [key]: p.items, ...(p.nextCursor && { nextCursor: p.nextCursor }) }) as Record<K, T[]> & { nextCursor?: string };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "errors", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => errors.summary() },
    { method: "GET", path: "/api/v1/overview", auth: "viewer", handle: () => errors.overview() },

    // Events in, from the application, with its project key.
    {
      method: "POST",
      path: "/api/v1/events",
      auth: "project",
      handle: async ({ req, res, project }) => {
        const raw = await readBody(req, EVENT_LIMIT);
        let body: unknown;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new ErrorsError(400, "invalid-json", "The body must be a JSON object.");
        }
        json(res, 201, errors.ingest(project!, body));
      },
    },

    // Projects.
    { method: "GET", path: "/api/v1/projects", auth: "viewer", handle: ({ url }) => page("projects", errors.listProjects(cursor(url), limit(url))) },
    { method: "POST", path: "/api/v1/projects", auth: "admin", handle: async ({ res, body }) => json(res, 201, errors.createProject(await body())) },
    { method: "GET", path: "/api/v1/projects/:id", auth: "viewer", handle: ({ params }) => errors.project(params[0]!) },
    { method: "PATCH", path: "/api/v1/projects/:id", auth: "admin", handle: async ({ params, body }) => errors.updateProject(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/projects/:id", auth: "admin", handle: ({ res, params }) => (errors.deleteProject(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/projects/:id/key", auth: "admin", handle: ({ res, params }) => json(res, 201, errors.rotateKey(params[0]!)) },

    // Issues.
    { method: "GET", path: "/api/v1/issues", auth: "viewer", handle: ({ url }) => page("issues", errors.issues(issueFilter(url), cursor(url), limit(url))) },
    { method: "GET", path: "/api/v1/issues/:id", auth: "viewer", handle: ({ params }) => errors.issue(params[0]!) },
    { method: "PATCH", path: "/api/v1/issues/:id", auth: "editor", handle: async ({ params, body }) => errors.updateIssue(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/issues/:id", auth: "admin", handle: ({ res, params }) => (errors.deleteIssue(params[0]!), noContent(res)) },

    // Releases, as they were seen in events.
    {
      method: "GET",
      path: "/api/v1/releases",
      auth: "viewer",
      handle: ({ url }) => page("releases", errors.releases(url.searchParams.get("project") ?? undefined, cursor(url), limit(url))),
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  /** Checks who is calling. Returns the project when the route takes a project key. */
  function authorize(req: IncomingMessage, access: Access): { id: string; rateLimit: number } | null {
    if (access === "none") return null;
    if (access === "project") {
      const header = req.headers.authorization;
      const key = (req.headers["x-errors-key"] as string | undefined) ?? (header?.startsWith("Bearer ek_") ? header.slice(7) : undefined);
      const project = errors.projectOfKey(key);
      if (!project)
        throw new ErrorsError(401, "invalid-token", "Send a project key in x-errors-key, or as a bearer token. A key is shown when its project is created.");
      return project;
    }
    if (tokenMatches(req.headers.authorization, adminToken)) return null;
    auth.authorize(req, access);
    return null;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready to take scans as long as the database answers.
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(errors, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const project = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, body: () => readJson(req), project });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof ErrorsError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: url(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string, which may name hosts and images. */
const url = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
