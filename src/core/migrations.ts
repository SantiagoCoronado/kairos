import type { DbDriver } from './driver'
import type { Logger } from './logger'
import { noopLogger } from './logger'

// Append-only list. Each entry runs once, in order, inside a transaction.
// Never edit a shipped migration — add a new one.
export const migrations: string[] = [
  // 001 — initial schema
  `
CREATE TABLE people (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  nickname       TEXT,
  email          TEXT,
  phone          TEXT,
  company        TEXT,
  role           TEXT,
  area           TEXT NOT NULL DEFAULT 'personal' CHECK (area IN ('personal','work')),
  cadence_days   INTEGER,
  snoozed_until  TEXT,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT
);

CREATE TABLE interactions (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'other'
              CHECK (kind IN ('call','message','email','meeting','coffee','other')),
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_interactions_person ON interactions(person_id, occurred_at DESC);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  area        TEXT NOT NULL DEFAULT 'personal' CHECK (area IN ('personal','work')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo'
               CHECK (status IN ('todo','in_progress','done','cancelled')),
  area         TEXT NOT NULL DEFAULT 'personal' CHECK (area IN ('personal','work')),
  priority     INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  person_id    TEXT REFERENCES people(id) ON DELETE SET NULL,
  due_date     TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TABLE objectives (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  area        TEXT NOT NULL DEFAULT 'personal' CHECK (area IN ('personal','work')),
  period      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE key_results (
  id            TEXT PRIMARY KEY,
  objective_id  TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT '',
  start_value   REAL NOT NULL DEFAULT 0,
  target_value  REAL NOT NULL DEFAULT 100,
  current_value REAL NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_krs_objective ON key_results(objective_id);

CREATE TABLE task_key_results (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  key_result_id TEXT NOT NULL REFERENCES key_results(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, key_result_id)
);

CREATE TABLE chat_sessions (
  id              TEXT PRIMARY KEY,
  sdk_session_id  TEXT,
  title           TEXT NOT NULL DEFAULT 'New chat',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`
]

export function migrate(db: DbDriver, log: Logger = noopLogger): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`)

  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version)
  )

  migrations.forEach((sql, i) => {
    const version = i + 1
    if (applied.has(version)) return
    db.transaction(() => {
      db.exec(sql)
      db.run('INSERT INTO schema_migrations (version) VALUES (?)', version)
    })
    log.info(`migration ${version} applied`)
  })
}
