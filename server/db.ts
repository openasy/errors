import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- An application that sends errors. Its key is shown once and kept only as a hash.
   CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     key_hash TEXT NOT NULL UNIQUE,
     key_prefix TEXT NOT NULL,
     rate_limit INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   -- Events that share a fingerprint. Resolving remembers the release it was fixed in; an event after that
   -- reopens the issue and marks it as a regression.
   CREATE TABLE issues (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
     fingerprint TEXT NOT NULL,
     title TEXT NOT NULL,
     culprit TEXT,
     level TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('unresolved', 'resolved', 'ignored')),
     first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL,
     events INTEGER NOT NULL,
     users INTEGER NOT NULL DEFAULT 0,
     resolved_at TEXT,
     resolved_in TEXT,
     regression INTEGER NOT NULL DEFAULT 0,
     regressed_in TEXT,
     UNIQUE (project_id, fingerprint)
   );
   CREATE INDEX issues_project_seen ON issues (project_id, last_seen DESC);
   CREATE TABLE issue_users (issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE, user_id TEXT NOT NULL, PRIMARY KEY (issue_id, user_id));
   CREATE TABLE issue_environments (issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE, environment TEXT NOT NULL, PRIMARY KEY (issue_id, environment));
   CREATE TABLE issue_releases (
     issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
     release TEXT NOT NULL,
     first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL,
     events INTEGER NOT NULL,
     PRIMARY KEY (issue_id, release)
   );
   CREATE INDEX issue_releases_release ON issue_releases (release);
   -- The latest events of an issue, with their stack traces. Older ones are deleted as new ones arrive.
   CREATE TABLE events (
     id TEXT PRIMARY KEY,
     issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
     timestamp TEXT NOT NULL,
     received_at TEXT NOT NULL,
     level TEXT NOT NULL,
     message TEXT,
     exception TEXT,
     release TEXT,
     environment TEXT NOT NULL,
     user_id TEXT,
     tags TEXT,
     request TEXT
   );
   CREATE INDEX events_issue ON events (issue_id, timestamp DESC);
   -- Releases as they were seen in events.
   CREATE TABLE releases (
     project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
     release TEXT NOT NULL,
     first_seen TEXT NOT NULL,
     new_issues INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (project_id, release)
   )`,
  // Events of each issue on each day (UTC), counted as they arrive: only the latest events themselves are kept.
  `CREATE TABLE issue_days (
     issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
     day TEXT NOT NULL,
     events INTEGER NOT NULL,
     PRIMARY KEY (issue_id, day)
   );
   CREATE INDEX issue_days_day ON issue_days (day)`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
