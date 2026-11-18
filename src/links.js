// What a task touched: files, commits, branches, PRs. Lets you ask "why did this file change?".
import fs from 'node:fs';
import path from 'node:path';
import { open } from './db.js';

const KINDS = ['file', 'commit', 'branch', 'pr'];

export function addLink(taskId, kind, ref) {
  if (!KINDS.includes(kind)) throw new Error(`bad link kind "${kind}" (one of: ${KINDS.join(', ')})`);
  const value = String(ref ?? '').trim();
  if (!value) return false;
  return (
    open()
      .prepare('INSERT OR IGNORE INTO links(task_id, kind, ref, at) VALUES(?,?,?,?)')
      .run(Number(taskId), kind, value, new Date().toISOString()).changes > 0
  );
}

/** Store file paths relative to the project when they are inside it. */
export function relFile(file, project) {
  const abs = path.resolve(project, file);
  return abs.startsWith(project + path.sep) ? abs.slice(project.length + 1) : abs;
}

/** Current branch and commit, read straight from .git (no git process). Null outside a normal checkout. */
export function gitHead(project) {
  try {
    const gitDir = path.join(project, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref: (refs\/heads\/(.+))$/.exec(head);
    if (!m) return { branch: null, commit: head.slice(0, 12) };
    let sha = null;
    try {
      sha = fs.readFileSync(path.join(gitDir, m[1]), 'utf8').trim();
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      sha = new RegExp(`^([0-9a-f]{40}) ${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(packed)?.[1] ?? null;
    }
    return { branch: m[2], commit: sha ? sha.slice(0, 12) : null };
  } catch {
    return null;
  }
}

export function linkGit(taskId, project) {
  const head = gitHead(project);
  if (!head) return;
  if (head.branch) addLink(taskId, 'branch', head.branch);
  if (head.commit) addLink(taskId, 'commit', head.commit);
}

export function linksFor(taskId) {
  return open().prepare('SELECT kind, ref, at FROM links WHERE task_id=? ORDER BY at, rowid').all(Number(taskId));
}

/** Attach files edited during this turn to every task the session has in progress. */
export function linkFilesToSession(sessionId, files, project) {
  if (!files.length) return 0;
  const tasks = open().prepare(`SELECT id FROM tasks WHERE session_id=? AND status='in_progress'`).all(sessionId);
  let n = 0;
  for (const t of tasks) for (const f of files) if (addLink(t.id, 'file', relFile(f, project))) n++;
  return n;
}

/** Tasks that touched a file, newest first. Matches a full path, a project-relative path or a path suffix. */
export function why(file, { project, all = false, limit = 20 } = {}) {
  const q = String(file).trim().replace(/^\.\//, '');
  const rel = project ? relFile(q, project) : q;
  const like = `%/${q.replace(/[\\%_]/g, '\\$&')}`;
  const scope = all || !project ? '' : 'AND t.project=?';
  return open()
    .prepare(
      `SELECT t.*, l.ref AS file, l.at AS linked_at FROM links l JOIN tasks t ON t.id=l.task_id
       WHERE l.kind='file' AND (l.ref=? OR l.ref=? OR l.ref LIKE ? ESCAPE '\\') ${scope}
       ORDER BY l.at DESC, t.id DESC LIMIT ?`,
    )
    .all(...[rel, q, like, ...(scope ? [project] : []), limit]);
}
