import { createHash } from "node:crypto";

export const LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;
export type Level = (typeof LEVELS)[number];

export interface Frame {
  filename: string;
  function: string | null;
  lineno: number | null;
  in_app: boolean;
}

export interface Event {
  timestamp: string;
  level: Level;
  message: string | null;
  exception: { type: string; value: string | null; frames: Frame[] } | null;
  release: string | null;
  environment: string;
  userId: string | null;
  tags: Record<string, string>;
  request: { url: string; method: string | null } | null;
  /** Set by the client to group events its own way. */
  fingerprint: string[] | null;
}

export class EventError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (m: string) => new EventError(m);

/** Passwords, tokens and keys in text an application sent are replaced before anything is stored (ADR 0042). */
export function mask(value: string): string {
  return value
    .replace(/((?:authorization|cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]+/gi, "$1***")
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|session(?:id)?)["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer ***")
    .replace(/\b(?:AKIA|ASIA|ghp_|gho_|ghs_|glpat-|xox[abp]-|sk_live_|sk-)[A-Za-z0-9_-]{8,}/g, "***");
}

const SENSITIVE_TAG = /pass|secret|token|key|auth|cookie|session/i;

function str(v: unknown, name: string, max: number, required = false): string | null {
  if (v === undefined || v === null) {
    if (required) throw bad(`${name} is required.`);
    return null;
  }
  if (typeof v !== "string") throw bad(`${name} must be a string.`);
  const t = v.trim();
  if (!t) {
    if (required) throw bad(`${name} is required.`);
    return null;
  }
  return t.slice(0, max);
}

/** Checks one event of the schema in openapi.json and masks what it holds. Request bodies and cookies are not part of it. */
export function parseEvent(body: unknown, now: () => number): Event {
  if (!isObj(body)) throw bad("The body must be a JSON object.");
  const allowed = new Set(["timestamp", "level", "message", "exception", "release", "environment", "user", "tags", "request", "fingerprint"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw bad(`${k} is not part of an event.`);

  let timestamp = new Date(now()).toISOString();
  if (body.timestamp !== undefined) {
    const t = typeof body.timestamp === "string" ? Date.parse(body.timestamp) : typeof body.timestamp === "number" ? body.timestamp * 1000 : NaN;
    if (Number.isNaN(t)) throw bad("timestamp must be an ISO 8601 date or Unix seconds.");
    // A clock that is wrong by more than a day is the application's, not an event from the future.
    if (t > now() + 86_400_000) throw bad("timestamp is in the future.");
    timestamp = new Date(t).toISOString();
  }
  const level = (body.level ?? "error") as Level;
  if (!LEVELS.includes(level)) throw bad(`level must be one of ${LEVELS.join(", ")}.`);

  const message = str(body.message, "message", 2000);
  let exception: Event["exception"] = null;
  if (body.exception !== undefined) {
    if (!isObj(body.exception)) throw bad("exception must be an object.");
    const e = body.exception;
    const frames: Frame[] = [];
    if (e.frames !== undefined) {
      if (!Array.isArray(e.frames) || e.frames.length > 100) throw bad("exception.frames must be a list of at most 100 frames, the most recent call last.");
      for (const f of e.frames) {
        if (!isObj(f)) throw bad("A frame must be an object.");
        const filename = str(f.filename, "frame.filename", 500, true)!.replace(/[?#].*$/, "");
        if (f.lineno !== undefined && f.lineno !== null && !Number.isInteger(f.lineno)) throw bad("frame.lineno must be an integer.");
        if (f.in_app !== undefined && typeof f.in_app !== "boolean") throw bad("frame.in_app must be true or false.");
        frames.push({ filename, function: str(f.function, "frame.function", 200), lineno: (f.lineno as number | null | undefined) ?? null, in_app: f.in_app ?? false });
      }
    }
    const value = str(e.value, "exception.value", 2000);
    exception = { type: str(e.type, "exception.type", 200, true)!, value: value === null ? null : mask(value), frames };
  }
  if (!message && !exception) throw bad("Send a message or an exception.");

  const tags: Record<string, string> = {};
  if (body.tags !== undefined) {
    if (!isObj(body.tags) || Object.keys(body.tags).length > 20) throw bad("tags must be an object with at most 20 entries.");
    for (const [k, v] of Object.entries(body.tags)) {
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(k) || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) throw bad("tag names are up to 64 letters, digits and _ . : -, and values are strings, numbers or booleans.");
      tags[k] = SENSITIVE_TAG.test(k) ? "***" : mask(String(v).slice(0, 200));
    }
  }

  let userId: string | null = null;
  if (body.user !== undefined) {
    if (!isObj(body.user) || Object.keys(body.user).some((k) => k !== "id")) throw bad("user may only hold an id: names, emails and addresses are not kept.");
    userId = str(body.user.id, "user.id", 128);
  }
  let request: Event["request"] = null;
  if (body.request !== undefined) {
    if (!isObj(body.request) || Object.keys(body.request).some((k) => k !== "url" && k !== "method")) throw bad("request may only hold a url and a method: bodies, headers and cookies are not kept.");
    const raw = str(body.request.url, "request.url", 2048);
    const url = raw ? URL.parse(raw) : null;
    if (raw && !url) throw bad("request.url must be an address.");
    request = url ? { url: url.origin + url.pathname, method: str(body.request.method, "request.method", 16)?.toUpperCase() ?? null } : null;
  }

  let fingerprint: string[] | null = null;
  if (body.fingerprint !== undefined) {
    if (!Array.isArray(body.fingerprint) || body.fingerprint.length < 1 || body.fingerprint.length > 8 || body.fingerprint.some((p) => typeof p !== "string" || !p || p.length > 200)) throw bad("fingerprint must be a list of 1 to 8 strings.");
    fingerprint = body.fingerprint as string[];
  }
  const environment = str(body.environment, "environment", 64) ?? "production";
  return { timestamp, level, message: message ? mask(message) : null, exception, release: str(body.release, "release", 200), environment, userId, tags, request, fingerprint };
}

/** Numbers, hex values, UUIDs and quoted text change from one occurrence to the next; the sentence does not. */
export function normalizeMessage(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What makes two events the same issue: the client's own fingerprint, or the exception type with the last three
 * frames of the application's own code (file and function, never line numbers, so a deploy that moves code keeps its
 * issues), or the normalized message.
 */
export function fingerprintOf(e: Event): string {
  let parts: string[];
  if (e.fingerprint) parts = ["custom", ...e.fingerprint];
  else if (e.exception && e.exception.frames.length) {
    const own = e.exception.frames.filter((f) => f.in_app);
    // Frames are listed with the most recent call last.
    const top = (own.length ? own : e.exception.frames).slice(-3);
    parts = ["exception", e.exception.type, ...top.map((f) => `${f.filename}|${f.function ?? ""}`)];
  } else if (e.exception) parts = ["exception", e.exception.type, normalizeMessage(e.exception.value ?? "")];
  else parts = ["message", normalizeMessage(e.message ?? "")];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

export function titleOf(e: Event): string {
  if (e.exception) return `${e.exception.type}${e.exception.value ? `: ${e.exception.value}` : ""}`.slice(0, 300);
  return (e.message ?? "").slice(0, 300);
}

/** The code the error came from: the most recent frame of the application. */
export function culpritOf(e: Event): string | null {
  const frames = e.exception?.frames ?? [];
  const f = [...frames].reverse().find((x) => x.in_app) ?? frames[frames.length - 1];
  return f ? `${f.function ?? "?"} (${f.filename}${f.lineno ? `:${f.lineno}` : ""})` : null;
}
