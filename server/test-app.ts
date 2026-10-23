// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import { createErrors, type ErrorsOptions } from "./errors.ts";

export const ADMIN_TOKEN = "test-admin-token";

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-10-22T12:00:00Z")) {
  let t = start;
  const clock = Object.assign(() => t, { advance: (ms: number) => void (t += ms) });
  return clock;
}

export async function startApp(opts: Partial<AppOptions> & { version: string; errorsOptions?: ErrorsOptions }) {
  const db = openDb(":memory:");
  const { errorsOptions, ...rest } = opts;
  const clock = fakeClock();
  const errors = createErrors(db, { ...errorsOptions, clock });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "errors", productName: "OpenAsy Errors", origin: base });
  handler = createApp({ db, errors, auth, adminToken: ADMIN_TOKEN, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  /** Sends an event the way an application does, with a project key. */
  const send = (key: string, event: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/events`, {
      method: "POST",
      body: typeof event === "string" || Buffer.isBuffer(event) ? (event as string) : JSON.stringify(event),
      headers: { "x-errors-key": key, "content-type": "application/json", ...headers },
    });
  const project = async (name: string, rateLimit?: number) =>
    (await (await admin("/api/v1/projects", { method: "POST", body: JSON.stringify({ name, ...(rateLimit && { rateLimit }) }) })).json()) as {
      id: string;
      key: string;
    };
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, errors, auth, base, admin, send, project, clock, close };
}
