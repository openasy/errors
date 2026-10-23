import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { culpritOf, EventError, fingerprintOf, parseEvent, titleOf, type Event } from "./event.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "invalid-event"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "not-configured"
  | "payload-too-large"
  | "internal-error";

export class ErrorsError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, detail: string, retryAfter?: number) {
    super(detail);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type Status = "unresolved" | "resolved" | "ignored";
const STATUSES: Status[] = ["unresolved", "resolved", "ignored"];
const SORTS = {
  lastSeen: "i.last_seen DESC",
  firstSeen: "i.first_seen DESC",
  events: "i.events DESC, i.last_seen DESC",
  users: "i.users DESC, i.last_seen DESC",
} as const;
type Sort = keyof typeof SORTS;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Events one issue keeps with their stack traces. */
export const EVENTS_PER_ISSUE = 20;
const MAX_RATE = 100_000;

const bad = (detail: string) => new ErrorsError(422, "invalid-body", detail);
const notFound = (what: string) => new ErrorsError(404, "not-found", `${what} does not exist.`);

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

export interface IssueFilter {
  projectId?: string;
  status?: Status;
  environment?: string;
  release?: string;
  q?: string;
  sort: Sort;
}

export interface ErrorsOptions {
  /** Issues with no event for this long, and events older than it, are deleted (ADR 0015). */
  retentionDays?: number;
  /** Events per minute a project may send when it has no limit of its own. */
  defaultRate?: number;
  /** For tests. */
  clock?: () => number;
}

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function createErrors(db: DatabaseSync, { retentionDays = 90, defaultRate = 600, clock = Date.now }: ErrorsOptions = {}) {
  const now = () => new Date(clock()).toISOString();
  // Events seen in the current minute, by project. Memory only: a restart gives everyone a fresh minute.
  const windows = new Map<string, { start: number; count: number }>();

  const projectRow = (id: string) => {
    const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!r) throw notFound("The project");
    return r;
  };

  function presentProject(p: Record<string, any>) {
    const open = (db.prepare("SELECT COUNT(*) AS n FROM issues WHERE project_id = ? AND status = 'unresolved'").get(p.id) as { n: number }).n;
    const last = (db.prepare("SELECT MAX(last_seen) AS t FROM issues WHERE project_id = ?").get(p.id) as { t: string | null }).t;
    return {
      id: p.id as string,
      name: p.name as string,
      keyPrefix: p.key_prefix as string,
      rateLimit: p.rate_limit as number,
      unresolved: open,
      lastEventAt: last,
      createdAt: p.created_at as string,
    };
  }

  const newKey = () => {
    const key = `ek_${randomBytes(24).toString("hex")}`;
    return { key, hash: hashKey(key), prefix: key.slice(0, 11) };
  };

  function presentIssue(i: Record<string, any>) {
    return {
      id: i.id as string,
      project: { id: i.project_id as string, name: i.project_name as string },
      title: i.title as string,
      culprit: (i.culprit as string | null) ?? null,
      level: i.level as string,
      status: i.status as Status,
      firstSeen: i.first_seen as string,
      lastSeen: i.last_seen as string,
      events: i.events as number,
      users: i.users as number,
      resolvedAt: (i.resolved_at as string | null) ?? null,
      resolvedIn: (i.resolved_in as string | null) ?? null,
      regression: i.regression === 1 ? { in: (i.regressed_in as string | null) ?? null } : null,
    };
  }

  const issueRow = (id: string) => {
    const r = db.prepare("SELECT i.*, p.name AS project_name FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ?").get(id) as
      Record<string, any> | undefined;
    if (!r) throw notFound("The issue");
    return r;
  };

  return {
    // ---------------------------------------------------------------- projects
    createProject(body: Record<string, unknown>) {
      const { name, rateLimit, ...rest } = body;
      if (Object.keys(rest).length || typeof name !== "string" || !NAME.test(name))
        throw bad("Expected { name, rateLimit? }; name is up to 64 letters, digits, . _ and -.");
      const rate = rateLimit === undefined ? defaultRate : rateLimit;
      if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 1 || rate > MAX_RATE) throw bad(`rateLimit is events per minute, 1 to ${MAX_RATE}.`);
      if (db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name)) throw new ErrorsError(409, "conflict", "A project with this name exists.");
      const { key, hash, prefix } = newKey();
      const id = randomUUID();
      db.prepare("INSERT INTO projects (id, name, key_hash, key_prefix, rate_limit, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        name,
        hash,
        prefix,
        rate,
        now(),
      );
      return { ...presentProject(projectRow(id)), key };
    },
    listProjects(cursor: string | undefined, limit: number): Page<ReturnType<typeof presentProject>> {
      const offset = decodeCursor(cursor);
      const rows = db.prepare("SELECT * FROM projects ORDER BY name LIMIT ? OFFSET ?").all(limit + 1, offset) as Array<Record<string, any>>;
      return { items: rows.slice(0, limit).map(presentProject), ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) };
    },
    project: (id: string) => presentProject(projectRow(id)),
    updateProject(id: string, body: Record<string, unknown>) {
      projectRow(id);
      const { rateLimit, ...rest } = body;
      if (Object.keys(rest).length || rateLimit === undefined) throw bad("Expected { rateLimit }.");
      if (typeof rateLimit !== "number" || !Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > MAX_RATE)
        throw bad(`rateLimit is events per minute, 1 to ${MAX_RATE}.`);
      db.prepare("UPDATE projects SET rate_limit = ? WHERE id = ?").run(rateLimit, id);
      return presentProject(projectRow(id));
    },
    /** A new key; the old one stops working at once. */
    rotateKey(id: string) {
      projectRow(id);
      const { key, hash, prefix } = newKey();
      db.prepare("UPDATE projects SET key_hash = ?, key_prefix = ? WHERE id = ?").run(hash, prefix, id);
      return { ...presentProject(projectRow(id)), key };
    },
    deleteProject(id: string) {
      if (db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes === 0) throw notFound("The project");
      windows.delete(id);
    },
    /** The project a key belongs to, or null. */
    projectOfKey(key: string | undefined): { id: string; rateLimit: number } | null {
      if (!key || !key.startsWith("ek_")) return null;
      const r = db.prepare("SELECT id, rate_limit FROM projects WHERE key_hash = ?").get(hashKey(key)) as { id: string; rate_limit: number } | undefined;
      return r ? { id: r.id, rateLimit: r.rate_limit } : null;
    },

    // ---------------------------------------------------------------- events
    /** Takes one event from an application. Counts it against the project's minute first, so a flood costs nothing more. */
    ingest(project: { id: string; rateLimit: number }, body: unknown) {
      const t = clock();
      const w = windows.get(project.id);
      if (!w || t - w.start >= 60_000) windows.set(project.id, { start: t, count: 1 });
      else if (w.count >= project.rateLimit)
        throw new ErrorsError(
          429,
          "rate-limited",
          `This project may send ${project.rateLimit} events a minute.`,
          Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000)),
        );
      else w.count++;

      let event: Event;
      try {
        event = parseEvent(body, clock);
      } catch (err) {
        if (err instanceof EventError) throw new ErrorsError(422, "invalid-event", err.message);
        throw err;
      }
      const fingerprint = fingerprintOf(event);
      const at = now();
      const eventId = randomUUID();

      db.exec("BEGIN IMMEDIATE");
      try {
        let issue = db.prepare("SELECT * FROM issues WHERE project_id = ? AND fingerprint = ?").get(project.id, fingerprint) as Record<string, any> | undefined;
        let isNew = false;
        let regression = false;
        if (!issue) {
          isNew = true;
          const id = randomUUID();
          db.prepare(
            "INSERT INTO issues (id, project_id, fingerprint, title, culprit, level, status, first_seen, last_seen, events) VALUES (?, ?, ?, ?, ?, ?, 'unresolved', ?, ?, 0)",
          ).run(id, project.id, fingerprint, titleOf(event), culpritOf(event), event.level, event.timestamp, event.timestamp);
          issue = { id, status: "unresolved" };
          if (event.release) db.prepare("UPDATE releases SET new_issues = new_issues + 1 WHERE project_id = ? AND release = ?").run(project.id, event.release);
        }
        const issueId = issue.id as string;
        if (event.release) {
          db.prepare(
            "INSERT INTO releases (project_id, release, first_seen, new_issues) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, release) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen)",
          ).run(project.id, event.release, event.timestamp, isNew ? 1 : 0);
          db.prepare(
            `INSERT INTO issue_releases (issue_id, release, first_seen, last_seen, events) VALUES (?, ?, ?, ?, 1)
             ON CONFLICT (issue_id, release) DO UPDATE SET events = events + 1, first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)`,
          ).run(issueId, event.release, event.timestamp, event.timestamp);
        }
        db.prepare("INSERT OR IGNORE INTO issue_environments (issue_id, environment) VALUES (?, ?)").run(issueId, event.environment);
        if (event.userId) db.prepare("INSERT OR IGNORE INTO issue_users (issue_id, user_id) VALUES (?, ?)").run(issueId, event.userId);
        // A fixed issue that happens again is a regression, in whatever release: the fix did not hold (ADR 0042).
        if (issue.status === "resolved") {
          regression = true;
          db.prepare("UPDATE issues SET status = 'unresolved', regression = 1, regressed_in = ?, resolved_at = NULL WHERE id = ?").run(event.release, issueId);
        }
        db.prepare(
          `UPDATE issues SET events = events + 1, last_seen = MAX(last_seen, ?), level = ?, title = ?, culprit = COALESCE(?, culprit),
             users = (SELECT COUNT(*) FROM issue_users WHERE issue_id = ?) WHERE id = ?`,
        ).run(event.timestamp, event.level, titleOf(event), culpritOf(event), issueId, issueId);
        db.prepare(
          "INSERT INTO events (id, issue_id, timestamp, received_at, level, message, exception, release, environment, user_id, tags, request) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          eventId,
          issueId,
          event.timestamp,
          at,
          event.level,
          event.message,
          event.exception ? JSON.stringify(event.exception) : null,
          event.release,
          event.environment,
          event.userId,
          Object.keys(event.tags).length ? JSON.stringify(event.tags) : null,
          event.request ? JSON.stringify(event.request) : null,
        );
        db.prepare(
          "DELETE FROM events WHERE issue_id = ? AND id NOT IN (SELECT id FROM events WHERE issue_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?)",
        ).run(issueId, issueId, EVENTS_PER_ISSUE);
        db.exec("COMMIT");
        return { id: eventId, issue: { id: issueId, new: isNew, regression } };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    // ---------------------------------------------------------------- issues
    issues(filter: IssueFilter, cursor: string | undefined, limit: number): Page<ReturnType<typeof presentIssue>> {
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (filter.projectId) (projectRow(filter.projectId), where.push("i.project_id = ?"), args.push(filter.projectId));
      if (filter.status) (where.push("i.status = ?"), args.push(filter.status));
      if (filter.environment)
        (where.push("EXISTS (SELECT 1 FROM issue_environments e WHERE e.issue_id = i.id AND e.environment = ?)"), args.push(filter.environment));
      if (filter.release) (where.push("EXISTS (SELECT 1 FROM issue_releases r WHERE r.issue_id = i.id AND r.release = ?)"), args.push(filter.release));
      if (filter.q) {
        const like = `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`;
        where.push("(i.title LIKE ? ESCAPE '\\' OR i.culprit LIKE ? ESCAPE '\\')");
        args.push(like, like);
      }
      const offset = decodeCursor(cursor);
      const rows = db
        .prepare(
          `SELECT i.*, p.name AS project_name FROM issues i JOIN projects p ON p.id = i.project_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${SORTS[filter.sort]}, i.id LIMIT ? OFFSET ?`,
        )
        .all(...args, limit + 1, offset) as Array<Record<string, any>>;
      return { items: rows.slice(0, limit).map(presentIssue), ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) };
    },

    issue(id: string) {
      const i = issueRow(id);
      const events = (db.prepare("SELECT * FROM events WHERE issue_id = ? ORDER BY timestamp DESC, rowid DESC").all(id) as Array<Record<string, any>>).map(
        (e) => ({
          id: e.id as string,
          timestamp: e.timestamp as string,
          level: e.level as string,
          message: (e.message as string | null) ?? null,
          exception: e.exception ? (JSON.parse(e.exception) as unknown) : null,
          release: (e.release as string | null) ?? null,
          environment: e.environment as string,
          user: e.user_id ? { id: e.user_id as string } : null,
          tags: e.tags ? (JSON.parse(e.tags) as Record<string, string>) : {},
          request: e.request ? (JSON.parse(e.request) as unknown) : null,
        }),
      );
      const releases = (
        db.prepare("SELECT release, first_seen, last_seen, events FROM issue_releases WHERE issue_id = ? ORDER BY first_seen").all(id) as Array<
          Record<string, any>
        >
      ).map((r) => ({ release: r.release as string, firstSeen: r.first_seen as string, lastSeen: r.last_seen as string, events: r.events as number }));
      const environments = (
        db.prepare("SELECT environment FROM issue_environments WHERE issue_id = ? ORDER BY environment").all(id) as Array<{ environment: string }>
      ).map((e) => e.environment);
      return { ...presentIssue(i), environments, releases, latestEvents: events };
    },

    /** Resolve (optionally in a release), ignore, or open again. */
    updateIssue(id: string, body: Record<string, unknown>) {
      issueRow(id);
      const { status, release, ...rest } = body;
      if (Object.keys(rest).length || typeof status !== "string" || !STATUSES.includes(status as Status))
        throw bad(`Expected { status, release? }; status is one of ${STATUSES.join(", ")}.`);
      if (release !== undefined && (typeof release !== "string" || !release || release.length > 200 || status !== "resolved"))
        throw bad("release (up to 200 characters) can only be sent when resolving: the release the fix ships in.");
      if (status === "resolved")
        db.prepare("UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_in = ?, regression = 0, regressed_in = NULL WHERE id = ?").run(
          now(),
          (release as string | undefined) ?? null,
          id,
        );
      else if (status === "ignored") db.prepare("UPDATE issues SET status = 'ignored', resolved_at = NULL, resolved_in = NULL WHERE id = ?").run(id);
      else db.prepare("UPDATE issues SET status = 'unresolved', resolved_at = NULL, resolved_in = NULL WHERE id = ?").run(id);
      return presentIssue(issueRow(id));
    },

    deleteIssue(id: string) {
      if (db.prepare("DELETE FROM issues WHERE id = ?").run(id).changes === 0) throw notFound("The issue");
    },

    releases(projectId: string | undefined, cursor: string | undefined, limit: number) {
      if (projectId) projectRow(projectId);
      const offset = decodeCursor(cursor);
      const rows = db
        .prepare(
          `SELECT r.*, p.name AS project_name, (SELECT COUNT(*) FROM issue_releases ir JOIN issues i ON i.id = ir.issue_id WHERE i.project_id = r.project_id AND ir.release = r.release) AS issues
           FROM releases r JOIN projects p ON p.id = r.project_id ${projectId ? "WHERE r.project_id = ?" : ""} ORDER BY r.first_seen DESC, r.release LIMIT ? OFFSET ?`,
        )
        .all(...(projectId ? [projectId] : []), limit + 1, offset) as Array<Record<string, any>>;
      return {
        items: rows.slice(0, limit).map((r) => ({
          project: { id: r.project_id as string, name: r.project_name as string },
          release: r.release as string,
          firstSeen: r.first_seen as string,
          newIssues: r.new_issues as number,
          issues: r.issues as number,
        })),
        ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }),
      } satisfies Page<unknown>;
    },

    summary() {
      const count = (status: Status) => (db.prepare("SELECT COUNT(*) AS n FROM issues WHERE status = ?").get(status) as { n: number }).n;
      const day = new Date(clock() - 86_400_000).toISOString();
      return {
        projects: (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n,
        issues: { unresolved: count("unresolved"), resolved: count("resolved"), ignored: count("ignored") },
        regressions: (db.prepare("SELECT COUNT(*) AS n FROM issues WHERE status = 'unresolved' AND regression = 1").get() as { n: number }).n,
        events24h: (db.prepare("SELECT COALESCE(SUM(events), 0) AS n FROM issues WHERE last_seen > ?").get(day) as { n: number }).n,
        lastEventAt: (db.prepare("SELECT MAX(last_seen) AS t FROM issues").get() as { t: string | null }).t,
      };
    },
    projectCount: () => (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n,
    issueTotals: () => {
      const out: Record<string, number> = { unresolved: 0, resolved: 0, ignored: 0 };
      for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM issues GROUP BY status").all() as Array<{ status: string; n: number }>) out[r.status] = r.n;
      return out;
    },

    purge() {
      const before = new Date(clock() - retentionDays * 86_400_000).toISOString();
      db.prepare("DELETE FROM issues WHERE last_seen < ?").run(before);
      db.prepare("DELETE FROM events WHERE timestamp < ?").run(before);
    },
  };
}

export type Errors = ReturnType<typeof createErrors>;
