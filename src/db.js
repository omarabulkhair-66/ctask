import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir() {
  return process.env.CTASK_HOME || path.join(os.homedir(), '.ctask');
}

export function dbPath() {
  return process.env.CTASK_DB || path.join(homeDir(), 'ctask.db');
}

const MIGRATIONS = [
  `
  CREATE TABLE tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project       TEXT NOT NULL,            -- absolute path (git root or cwd)
    session_id    TEXT,                     -- Claude session that owns / last claimed it
    parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL DEFAULT 'task',   -- task | step | reminder | automation
    title         TEXT NOT NULL,
    body          TEXT,                     -- what / why (context for humans and Claude)
    instructions  TEXT,                     -- how Claude should carry it out
    status        TEXT NOT NULL DEFAULT 'todo',
    priority      INTEGER NOT NULL DEFAULT 2,     -- 1 high, 2 normal, 3 low
    tags          TEXT,
    next_run      TEXT,                     -- ISO UTC; due time for reminders/automations
    recur         TEXT,                     -- interval like 30m, 2h, 1d, 1w
    resume        INTEGER NOT NULL DEFAULT 0,     -- automation: resume session_id instead of a fresh run
    last_run      TEXT,
    run_count     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    completed_at  TEXT
  );
  CREATE INDEX tasks_project_status ON tasks(project, status);
  CREATE INDEX tasks_next_run ON tasks(next_run);
  CREATE INDEX tasks_session ON tasks(session_id);

  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at         TEXT NOT NULL,
    session_id TEXT,
    type       TEXT NOT NULL,               -- created | status | update | note | run
    note       TEXT
  );
  CREATE INDEX events_task ON events(task_id);

  CREATE TABLE sessions (
    session_id     TEXT PRIMARY KEY,
    project        TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    last_seen      TEXT NOT NULL,
    last_prompt_at TEXT
  );
  CREATE INDEX sessions_project ON sessions(project, last_seen);
  `,
  `ALTER TABLE tasks ADD COLUMN notified_at TEXT;  -- last time a due notification was shown`,
  `ALTER TABLE tasks ADD COLUMN archived_at TEXT;  -- set on old closed tasks: hidden from lists and search by default`,
  `ALTER TABLE sessions ADD COLUMN handoff TEXT;      -- where the session stood, captured before compaction / at end
   ALTER TABLE sessions ADD COLUMN handoff_at TEXT;`,
  `
  ALTER TABLE tasks ADD COLUMN accept TEXT;          -- acceptance criteria: what must be true to call it done

  CREATE TABLE deps (                                -- task_id cannot start until depends_on is closed
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on)
  );
  CREATE INDEX deps_on ON deps(depends_on);

  CREATE TABLE links (                               -- what a task touched: file | commit | branch | pr
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    ref     TEXT NOT NULL,
    at      TEXT NOT NULL,
    PRIMARY KEY (task_id, kind, ref)
  );
  CREATE INDEX links_ref ON links(kind, ref);

  CREATE TABLE memory (                              -- durable project knowledge, not work items
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project    TEXT,                                 -- NULL = applies to every project
    kind       TEXT NOT NULL DEFAULT 'fact',         -- rule | decision | gotcha | fact
    text       TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX memory_project ON memory(project);

  CREATE TABLE playbooks (                           -- reusable task recipes
    name       TEXT PRIMARY KEY,
    spec       TEXT NOT NULL,                        -- JSON: {title, body, instructions, accept, steps:[{title, instructions}]}
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `,
];

let db;

export function open() {
  if (db) return db;
  const p = dbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
  const { user_version: v } = db.prepare('PRAGMA user_version').get();
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version=${i + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

export function close() {
  if (db) db.close();
  db = undefined;
}
