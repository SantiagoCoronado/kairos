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
`,
  // 002 — communications module (gmail / slack / whatsapp)
  `
CREATE TABLE comms_accounts (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN ('gmail','slack','whatsapp')),
  external_id   TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'connected'
                CHECK (status IN ('connected','needs_auth','error','disabled')),
  error         TEXT,
  sync_state    TEXT NOT NULL DEFAULT '{}',
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (provider, external_id)
);

CREATE TABLE comms_credentials (
  account_id  TEXT PRIMARY KEY REFERENCES comms_accounts(id) ON DELETE CASCADE,
  cipher      TEXT NOT NULL
);

CREATE TABLE comms_threads (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES comms_accounts(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('email','dm','group','channel')),
  title           TEXT NOT NULL DEFAULT '',
  snippet         TEXT NOT NULL DEFAULT '',
  last_message_at TEXT,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  sync_enabled    INTEGER NOT NULL DEFAULT 1,
  sync_cursor     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (account_id, external_id)
);
CREATE INDEX idx_comms_threads_recent ON comms_threads(last_message_at DESC);

CREATE TABLE comms_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES comms_threads(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL REFERENCES comms_accounts(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  sender_name     TEXT NOT NULL DEFAULT '',
  sender_handle   TEXT NOT NULL DEFAULT '',
  is_me           INTEGER NOT NULL DEFAULT 0,
  person_id       TEXT REFERENCES people(id) ON DELETE SET NULL,
  sent_at         TEXT NOT NULL,
  body_text       TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_read         INTEGER NOT NULL DEFAULT 0,
  raw_json        TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (account_id, external_id)
);
CREATE INDEX idx_comms_messages_thread ON comms_messages(thread_id, sent_at DESC);
CREATE INDEX idx_comms_messages_person ON comms_messages(person_id);

CREATE TABLE comms_identities (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  handle     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, handle)
);

CREATE TABLE comms_outbox (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES comms_accounts(id) ON DELETE CASCADE,
  thread_id    TEXT REFERENCES comms_threads(id) ON DELETE SET NULL,
  provider     TEXT NOT NULL,
  to_json      TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  in_reply_to  TEXT,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sending','sent','failed')),
  error        TEXT,
  source       TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','agent')),
  external_id  TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX idx_comms_outbox_status ON comms_outbox(status, created_at);
`,
  // 003 — manual ordering for tasks and objectives
  // backfill mirrors the pre-existing default ORDER BY so upgraded DBs keep
  // their visible order exactly
  `
ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE tasks SET sort_order = (
  SELECT rn FROM (
    SELECT id, ROW_NUMBER() OVER (
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
        due_date IS NULL, due_date, priority, created_at DESC
    ) AS rn FROM tasks
  ) ranked WHERE ranked.id = tasks.id
);
CREATE INDEX idx_tasks_sort ON tasks(sort_order);

ALTER TABLE objectives ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE objectives SET sort_order = (
  SELECT rn FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY period DESC, area, title) AS rn FROM objectives
  ) ranked WHERE ranked.id = objectives.id
);
`,
  // 004 — sender lookups: the WhatsApp name sweep updates messages by
  // (account_id, sender_handle) once per learned contact; without this index
  // each update was a full table scan and froze the main thread for seconds
  `
CREATE INDEX idx_comms_messages_sender ON comms_messages(account_id, sender_handle);
`,
  // 005 — inbox batch: manual account ordering, HTML email bodies, and
  // Gmail INBOX/archive state. Backfills derive from the labelIds already
  // stored in raw_json; non-gmail rows keep the inbox defaults.
  `
ALTER TABLE comms_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE comms_accounts SET sort_order = (
  SELECT rn FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn FROM comms_accounts
  ) ranked WHERE ranked.id = comms_accounts.id
);

ALTER TABLE comms_messages ADD COLUMN body_html TEXT;
ALTER TABLE comms_messages ADD COLUMN is_inbox INTEGER NOT NULL DEFAULT 1;
UPDATE comms_messages SET is_inbox = 0
WHERE provider = 'gmail' AND NOT (
  raw_json IS NOT NULL AND json_valid(raw_json)
  AND EXISTS (SELECT 1 FROM json_each(raw_json, '$.labelIds') WHERE value = 'INBOX')
);

ALTER TABLE comms_threads ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
UPDATE comms_threads SET is_archived = 1
WHERE provider = 'gmail' AND NOT EXISTS (
  SELECT 1 FROM comms_messages m WHERE m.thread_id = comms_threads.id AND m.is_inbox = 1
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
