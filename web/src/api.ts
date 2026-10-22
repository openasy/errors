// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type Level = "fatal" | "error" | "warning" | "info" | "debug";
export type IssueStatus = "unresolved" | "resolved" | "ignored";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Summary {
  projects: number;
  issues: Record<IssueStatus, number>;
  regressions: number;
  events24h: number;
  lastEventAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  keyPrefix: string;
  rateLimit: number;
  unresolved: number;
  lastEventAt: string | null;
  createdAt: string;
  /** Only in the answer that makes or replaces the key. */
  key?: string;
}

export interface Issue {
  id: string;
  project: { id: string; name: string };
  title: string;
  culprit: string | null;
  level: Level;
  status: IssueStatus;
  firstSeen: string;
  lastSeen: string;
  events: number;
  users: number;
  resolvedAt: string | null;
  resolvedIn: string | null;
  regression: { in: string | null } | null;
}

export interface Frame {
  filename: string;
  function: string | null;
  lineno: number | null;
  in_app: boolean;
}

export interface IssueEvent {
  id: string;
  timestamp: string;
  level: Level;
  message: string | null;
  exception: { type: string; value: string | null; frames: Frame[] } | null;
  release: string | null;
  environment: string;
  user: { id: string } | null;
  tags: Record<string, string>;
  request: { url: string; method: string | null } | null;
}

export interface IssueDetail extends Issue {
  environments: string[];
  releases: Array<{ release: string; firstSeen: string; lastSeen: string; events: number }>;
  latestEvents: IssueEvent[];
}

export interface Release {
  project: { id: string; name: string };
  release: string;
  firstSeen: string;
  newIssues: number;
  issues: number;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
