import fs from 'node:fs';
import path from 'node:path';
import { open } from './db.js';
import { parseEvery, parseWhen } from './time.js';

export const OPEN = ['todo', 'in_progress', 'blocked', 'waiting'];
export const STATUSES = [...OPEN, 'done', 'cancelled'];
export const KINDS = ['task', 'step', 'reminder', 'automation'];

const nowIso = () => new Date().toISOString();
const qs = (arr) => arr.map(() => '?').join(',');

/** Project identity = git root above cwd, else cwd itself. */
export function resolveProject(cwd = process.cwd()) {
  let dir;
  try {
    dir = fs.realpathSync(cwd);
  } catch {
    dir = path.resolve(cwd);
  }
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

// ---------- sessions ----------

export function touchSession(sessionId, project, { prompt = false } = {}) {
  if (!sessionId) return;
  const now = nowIso();
  open()
    .prepare(
      `INSERT INTO sessions(session_id, project, started_at, last_seen, last_prompt_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET project=excluded.project, last_seen=excluded.last_seen,
         last_prompt_at=COALESCE(excluded.last_prompt_at, sessions.last_prompt_at)`,
    )
    .run(sessionId, project, now, now, prompt ? now : null);
}

export function getSession(sessionId) {
  return open().prepare('SELECT * FROM sessions WHERE session_id=?').get(sessionId);
}

/** Env var set by the SessionStart hook, else the most recently seen session in this project. */
export function currentSession(project) {
  if (process.env.CTASK_SESSION_ID) return process.env.CTASK_SESSION_ID;
  const cutoff = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const row = open()
    .prepare('SELECT session_id FROM sessions WHERE project=? AND last_seen>? ORDER BY last_seen DESC LIMIT 1')
    .get(project, cutoff);
  return row?.session_id ?? null;
}

// ---------- tasks ----------

function logEvent(taskId, type, note, sessionId) {
  open()
    .prepare('INSERT INTO events(task_id, at, session_id, type, note) VALUES(?,?,?,?,?)')
    .run(taskId, nowIso(), sessionId ?? null, type, note ?? null);
}

function check(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`bad ${label} "${value}" (one of: ${allowed.join(', ')})`);
  return value;
}

function parsePriority(p) {
  const n = Number(p);
  if (![1, 2, 3].includes(n)) throw new Error(`bad priority "${p}" (1 high, 2 normal, 3 low)`);
  return n;
}

export function getTask(id) {
  const n = Number(String(id).replace(/^#/, ''));
  const t = Number.isInteger(n) ? open().prepare('SELECT * FROM tasks WHERE id=?').get(n) : undefined;
  if (!t) throw new Error(`task ${id} not found`);
  return t;
}

export function addTask(input) {
  const db = open();
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('title is required');

  let project = input.project ? resolveProject(input.project) : resolveProject();
  let parentId = null;
  if (input.parent != null) {
    const parent = getTask(input.parent);
    parentId = parent.id;
    project = parent.project;
  }
  const recur = input.every ? (parseEvery(input.every), String(input.every).trim()) : null;
  let nextRun = input.next ? parseWhen(input.next) : null;
  if (recur && !nextRun) nextRun = new Date(Date.now() + parseEvery(recur) * 1000).toISOString();

  const kind = input.kind
    ? check(input.kind, KINDS, 'kind')
    : parentId
      ? 'step'
      : nextRun
        ? 'reminder'
        : 'task';
  const status = input.status ? check(input.status, STATUSES, 'status') : 'todo';
  const session = input.session ?? currentSession(project);
  const now = nowIso();

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO tasks(project, session_id, parent_id, kind, title, body, instructions, status, priority,
                         tags, next_run, recur, resume, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      project,
      session,
      parentId,
      kind,
      title,
      input.body ?? null,
      input.instructions ?? null,
      status,
      input.priority != null ? parsePriority(input.priority) : 2,
      input.tags ?? null,
      nextRun,
      recur,
      input.resume ? 1 : 0,
      now,
      now,
    );
  const id = Number(lastInsertRowid);
  logEvent(id, 'created', null, session);
  return getTask(id);
}

/** Patch plain fields. `next`/`every` accept "none" to clear. */
export function updateTask(id, patch, { session, note } = {}) {
  const task = getTask(id);
  const set = {};
  if (patch.title != null) set.title = String(patch.title).trim();
  if (patch.body != null) set.body = patch.body;
  if (patch.instructions != null) set.instructions = patch.instructions;
  if (patch.kind != null) set.kind = check(patch.kind, KINDS, 'kind');
  if (patch.priority != null) set.priority = parsePriority(patch.priority);
  if (patch.tags != null) set.tags = patch.tags;
  if (patch.session != null) set.session_id = patch.session;
  if (patch.resume != null) set.resume = patch.resume ? 1 : 0;
  if (patch.parent != null) set.parent_id = patch.parent === 'none' ? null : getTask(patch.parent).id;
  if (patch.next != null) set.next_run = patch.next === 'none' ? null : parseWhen(patch.next);
  if (patch.every != null) {
    set.recur = patch.every === 'none' ? null : (parseEvery(patch.every), String(patch.every).trim());
  }
  const sid = session ?? currentSession(task.project);
  const keys = Object.keys(set);
  if (keys.length) {
    open()
      .prepare(`UPDATE tasks SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`)
      .run(...keys.map((k) => set[k]), nowIso(), task.id);
    logEvent(task.id, 'update', keys.join(', '), sid);
  }
  if (patch.status != null) setStatus(task.id, patch.status, { session: sid, note });
  else if (note) addNote(task.id, note, { session: sid });
  return getTask(task.id);
}

/**
 * Status transition. Marking a recurring task done reschedules it (back to todo, next_run += interval)
 * instead of closing it. Starting a task claims it for the current session.
 */
export function setStatus(id, status, { session, note } = {}) {
  check(status, STATUSES, 'status');
  const task = getTask(id);
  const db = open();
  const sid = session ?? currentSession(task.project);
  const now = nowIso();

  if (status === 'done' && task.recur) {
    const next = new Date(Date.now() + parseEvery(task.recur) * 1000).toISOString();
    db.prepare(
      `UPDATE tasks SET status='todo', next_run=?, last_run=?, run_count=run_count+1, updated_at=? WHERE id=?`,
    ).run(next, now, now, task.id);
    logEvent(task.id, 'status', `done (recurring) -> next ${next}${note ? ` — ${note}` : ''}`, sid);
    return getTask(task.id);
  }

  const closed = status === 'done' || status === 'cancelled';
  db.prepare(
    `UPDATE tasks SET status=?, updated_at=?, completed_at=?,
       archived_at=CASE WHEN ? THEN archived_at ELSE NULL END,
       session_id=CASE WHEN ?='in_progress' AND ? IS NOT NULL THEN ? ELSE session_id END,
       last_run=CASE WHEN ?='done' THEN ? ELSE last_run END,
       run_count=run_count + CASE WHEN ?='done' THEN 1 ELSE 0 END
     WHERE id=?`,
  ).run(status, now, closed ? now : null, closed ? 1 : 0, status, sid, sid, status, now, status, task.id);
  logEvent(task.id, 'status', `${task.status} -> ${status}${note ? ` — ${note}` : ''}`, sid);
  return getTask(task.id);
}

export function addNote(id, note, { session, type = 'note' } = {}) {
  const task = getTask(id);
  const text = String(note ?? '').trim();
  if (!text) throw new Error('note text is required');
  open().prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(nowIso(), task.id);
  logEvent(task.id, type, text, session ?? currentSession(task.project));
  return task;
}

export function removeTask(id) {
  const task = getTask(id);
  open().prepare('DELETE FROM tasks WHERE id=?').run(task.id);
  return task;
}

const ORDER = `
  CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'waiting' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END,
  priority, next_run IS NULL, next_run, id`;

/**
 * filter: { project, all, status: string[], closed, kind, session, due, parent, tag, limit }
 * Default: open tasks of `project`.
 */
function buildFilter(f) {
  const where = [];
  const args = [];
  // Free-text search: every word must appear in the title, body, instructions, tags or a log note.
  for (const word of String(f.q ?? '').split(/\s+/).filter(Boolean)) {
    const like = `%${word.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(
      `(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR instructions LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM events e WHERE e.task_id=tasks.id AND e.note LIKE ? ESCAPE '\\'))`,
    );
    args.push(like, like, like, like, like);
  }
  // archived: undefined = hide archived, true = include them, 'only' = just them
  if (f.archived === 'only') where.push('archived_at IS NOT NULL');
  else if (!f.archived) where.push('archived_at IS NULL');
  if (f.notDue) {
    where.push('(next_run IS NULL OR next_run>?)');
    args.push(nowIso());
  }
  if (f.notStatus) {
    where.push('status!=?');
    args.push(f.notStatus);
  }
  if (!f.all) {
    where.push('project=?');
    args.push(f.project ?? resolveProject());
  }
  if (f.status?.length) {
    f.status.forEach((s) => check(s, STATUSES, 'status'));
    where.push(`status IN (${qs(f.status)})`);
    args.push(...f.status);
  } else if (!f.closed && f.archived !== 'only') {
    where.push(`status IN (${qs(OPEN)})`);
    args.push(...OPEN);
  }
  if (f.kind) {
    where.push('kind=?');
    args.push(check(f.kind, KINDS, 'kind'));
  }
  if (f.session) {
    where.push('session_id=?');
    args.push(f.session);
  }
  if (f.parent != null) {
    where.push('parent_id=?');
    args.push(Number(f.parent));
  }
  if (f.tag) {
    where.push(`(',' || REPLACE(COALESCE(tags,''), ' ', '') || ',') LIKE ?`);
    args.push(`%,${f.tag},%`);
  }
  if (f.due) {
    where.push('next_run IS NOT NULL AND next_run<=?');
    args.push(nowIso());
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export const DEFAULT_LIMIT = 50;

export function listTasks(f = {}) {
  const { sql, args } = buildFilter(f);
  return open()
    .prepare(`SELECT * FROM tasks ${sql} ORDER BY ${ORDER} LIMIT ? OFFSET ?`)
    .all(...args, f.limit ?? DEFAULT_LIMIT, f.offset ?? 0);
}

/** Total number of tasks matching the same filter, ignoring limit/offset. */
export function countTasks(f = {}) {
  const { sql, args } = buildFilter(f);
  return open().prepare(`SELECT COUNT(*) AS n FROM tasks ${sql}`).get(...args).n;
}

/** One page plus the numbers needed to say where it sits. `page` is 1-based. */
export function pageTasks(f = {}) {
  const limit = Math.max(1, Number(f.limit) || DEFAULT_LIMIT);
  const page = Math.max(1, Number(f.page) || 1);
  const offset = (page - 1) * limit;
  const tasks = listTasks({ ...f, limit, offset });
  const total = countTasks(f);
  return { tasks, total, page, limit, from: tasks.length ? offset + 1 : 0, to: offset + tasks.length, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function taskDetail(id, { events = 15 } = {}) {
  const task = getTask(id);
  const db = open();
  return {
    task,
    children: db.prepare(`SELECT * FROM tasks WHERE parent_id=? ORDER BY id`).all(task.id),
    events: db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id DESC LIMIT ?').all(task.id, events).reverse(),
  };
}

/** What to work on now: due items, then in-progress, then ready todos (not scheduled for later). */
export function nextTasks({ project, all = false, limit = 5 } = {}) {
  const now = nowIso();
  const args = [];
  let scope = '';
  if (!all) {
    scope = 'project=? AND';
    args.push(project ?? resolveProject());
  }
  return open()
    .prepare(
      `SELECT * FROM tasks
       WHERE ${scope} status IN ('todo','in_progress') AND (next_run IS NULL OR next_run<=? OR status='in_progress')
       ORDER BY (next_run IS NOT NULL AND next_run<=?) DESC, status='in_progress' DESC, priority, id
       LIMIT ?`,
    )
    .all(...args, now, now, limit);
}

export function projectsSummary() {
  const now = nowIso();
  return open()
    .prepare(
      `SELECT project,
              COUNT(*) AS open,
              SUM(status='in_progress') AS in_progress,
              SUM(status='blocked') AS blocked,
              SUM(status='waiting') AS waiting,
              SUM(next_run IS NOT NULL AND next_run<=?) AS due,
              MAX(updated_at) AS updated_at
       FROM tasks WHERE status IN (${qs(OPEN)})
       GROUP BY project ORDER BY due DESC, updated_at DESC`,
    )
    .all(now, ...OPEN);
}

/** in_progress tasks owned by this session that were not touched since the user's last prompt. */
export function staleInProgress(sessionId) {
  const s = getSession(sessionId);
  if (!s?.last_prompt_at) return [];
  return open()
    .prepare(`SELECT * FROM tasks WHERE session_id=? AND status='in_progress' AND updated_at<? ORDER BY id`)
    .all(sessionId, s.last_prompt_at);
}

// ---------- archive ----------

/**
 * Archive closed tasks whose completion is older than `older` (an interval like 30d).
 * Steps stay visible while their parent is still open. Returns the affected tasks.
 */
export function archiveOld({ older = '30d', project, all = false, dryRun = false } = {}) {
  const cutoff = new Date(Date.now() - parseEvery(older) * 1000).toISOString();
  const args = [cutoff];
  let scope = '';
  if (!all) {
    scope = 'AND project=?';
    args.push(project ?? resolveProject());
  }
  const where = `status IN ('done','cancelled') AND archived_at IS NULL AND COALESCE(completed_at, updated_at)<? ${scope}
    AND (parent_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM tasks p WHERE p.id=tasks.parent_id AND p.status IN (${qs(OPEN)})))`;
  const db = open();
  const rows = db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY id`).all(...args, ...OPEN);
  if (!dryRun && rows.length) {
    db.prepare(`UPDATE tasks SET archived_at=? WHERE ${where}`).run(nowIso(), ...args, ...OPEN);
  }
  return rows;
}

export function archiveTask(id) {
  const task = getTask(id);
  if (OPEN.includes(task.status)) throw new Error(`#${task.id} is still ${task.status}; close it (done/cancel) before archiving`);
  open().prepare('UPDATE tasks SET archived_at=COALESCE(archived_at, ?) WHERE id=?').run(nowIso(), task.id);
  return getTask(task.id);
}

export function unarchiveTask(id) {
  const task = getTask(id);
  open().prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(task.id);
  return getTask(task.id);
}
